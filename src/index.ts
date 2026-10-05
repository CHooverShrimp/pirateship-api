import {
    FlatRatePackageTypes,
    PirateShipHttpError,
    PirateShipNetworkError,
    PirateShipRequestError,
    PirateShipValidationError,
    RateVariants,
    UpsDomesticService,
    UpsInternationalService,
    UspsDomesticMailClass,
    UspsInternationalMailClass,
} from './types'
import type {
    MailClassKey,
    PackageType,
    UnavailableService,
    Rate,
    RateQuote,
    RateVariant,
    ResponseMailClassKey,
    ShippingOptions,
} from './types'

export * from './types'

const ENDPOINT = 'https://ship.pirateship.com/api/graphql?opname=RatesQuery'

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

const FLAT_RATE: ReadonlySet<string> = new Set(FlatRatePackageTypes)

// Longest first: 'Flat_Rate_Envelope' is a suffix of 'Padded_Flat_Rate_Envelope',
// so a shortest-first match would split 'Priority_Padded_Flat_Rate_Envelope'
// into the service 'Priority_Padded', which does not exist.
const VARIANTS_LONGEST_FIRST = [...RateVariants].sort(
    (a, b) => b.length - a.length
)

/**
 * Split a response key into the service that was requested and its pricing
 * variant.
 *
 * ```ts
 * splitMailClassKey('Priority_Cubic') // { mailClassKey: 'Priority', variant: 'Cubic' }
 * splitMailClassKey('Priority')       // { mailClassKey: 'Priority', variant: null }
 * ```
 */
export function splitMailClassKey(key: ResponseMailClassKey): {
    mailClassKey: MailClassKey
    variant: RateVariant | null
} {
    for (const variant of VARIANTS_LONGEST_FIRST) {
        const suffix = `_${variant}`
        if (key.endsWith(suffix)) {
            return {
                mailClassKey: key.slice(0, -suffix.length) as MailClassKey,
                variant,
            }
        }
    }
    return { mailClassKey: key as MailClassKey, variant: null }
}

const NAME_BY_KEY: ReadonlyMap<string, string> = new Map(
    [
        UspsDomesticMailClass,
        UspsInternationalMailClass,
        UpsDomesticService,
        UpsInternationalService,
    ].flatMap((group) =>
        Object.entries(group).map(([name, key]) => [key as string, name])
    )
)

const UPS_KEYS: ReadonlySet<string> = new Set([
    ...Object.values(UpsDomesticService),
    ...Object.values(UpsInternationalService),
])

/**
 * The readable name for a mail class key, useful for logs and analytics where
 * the raw UPS numeric codes are meaningless.
 *
 * ```ts
 * mailClassName('65') // 'WorldwideSaver'
 * ```
 * Accepts response keys, whose variant suffix is stripped first.
 */
export function mailClassName(key: ResponseMailClassKey): string {
    const { mailClassKey } = splitMailClassKey(key)
    return NAME_BY_KEY.get(mailClassKey) ?? mailClassKey
}

/** Which carrier owns a mail class key. */
export function carrierOf(key: ResponseMailClassKey): 'usps' | 'ups' {
    return UPS_KEYS.has(splitMailClassKey(key).mailClassKey) ? 'ups' : 'usps'
}

/**
 * Strip the BBCode the API embeds in its description fields.
 *
 * ```ts
 * stripFormatting('in [b]6-10 days[/b]') // 'in 6-10 days'
 * ```
 */
export function stripFormatting(text: string): string {
    return text
        .replace(/\[link=[^\]]*\]/gi, '')
        .replace(/\[\/?[a-z]+\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
}

/* -------------------------------------------------------------------------- */
/*                                 Validation                                 */
/* -------------------------------------------------------------------------- */

const MINIMUMS = [
    ['dimensionX', 'length', 6],
    ['dimensionY', 'width', 3],
    ['dimensionZ', 'height', 0.25],
] as const

function validate(options: ShippingOptions): void {
    if (options.mailClassKeys.length === 0) {
        throw new PirateShipValidationError(
            'mailClassKeys',
            'mailClassKeys must name at least one service'
        )
    }
    if (options.packageTypeKeys.length === 0) {
        throw new PirateShipValidationError(
            'packageTypeKeys',
            'packageTypeKeys must name at least one package type'
        )
    }
    for (const packageType of options.packageTypeKeys) {
        if (FLAT_RATE.has(packageType)) continue
        for (const [field, label, min] of MINIMUMS) {
            // A soft envelope has no meaningful height.
            if (field === 'dimensionZ' && packageType === 'SoftEnvelope')
                continue
            const value = options[field]
            if (value !== undefined && value < min) {
                throw new PirateShipValidationError(
                    field,
                    `${packageType} ${label} (${field}) must be at least ${min} inches, got ${value}`
                )
            }
        }
    }
}

/* -------------------------------------------------------------------------- */
/*                              Request and parse                             */
/* -------------------------------------------------------------------------- */

const RATE_FIELDS = `
          title
          deliveryDescription
          trackingDescription
          serviceDescription
          pricingDescription
          cubicTier
          mailClassKey
          mailClass { accuracy international __typename }
          packageTypeKey
          zone
          surcharges { title price __typename }
          carrier { carrierKey title __typename }
          totalPrice
          priceBaseTypeKey
          basePrice
          crossedTotalPrice
          pricingType
          pricingSubType
          ratePeriodId
          learnMoreUrl
          isGuaranteedDelivery
          isSaturdayDelivery
          cheapest
          fastest
          __typename`

const ARGUMENTS = [
    ['originZip', 'String!'],
    ['originCity', 'String'],
    ['originRegionCode', 'String'],
    ['destinationZip', 'String'],
    ['destinationRegionCode', 'String'],
    ['destinationCountryCode', 'String'],
    ['isResidential', 'Boolean'],
    ['isPoBox', 'Boolean'],
    ['weight', 'Float'],
    ['dimensionX', 'Float'],
    ['dimensionY', 'Float'],
    ['dimensionZ', 'Float'],
    ['mailClassKeys', '[String!]!'],
    ['packageTypeKeys', '[String!]!'],
    ['pricingTypes', '[String!]'],
    ['priceBaseTypeKeys', '[String!]'],
    ['insuredValue', 'Float'],
    ['contentType', 'String'],
    ['shipDate', 'String'],
    ['showUpsRatesWhen2x7Selected', 'Boolean'],
] as const

const QUERY = `query RatesQuery(${ARGUMENTS.map(
    ([name, type]) => `$${name}: ${type}`
).join(', ')}) {
        rates(
${ARGUMENTS.map(([name]) => `          ${name}: $${name}`).join('\n')}
        ) {${RATE_FIELDS}
        }
      }`

/** Shape of a raw GraphQL error entry from the response body. */
interface GraphQlError {
    message?: string
    extensions?: {
        field?: string
        rateError?: {
            code?: number
            title?: string
            mailClassKey?: string
            packageTypeKey?: string
        }
    }
}

/**
 * Sort the response's errors into the two kinds that matter.
 *
 * A `rateError` names one service that could not be priced, which is routine
 * and gets returned. Anything else means the API rejected the request, in which
 * case it priced nothing at all, so it throws.
 */
function partitionErrors(raw: readonly GraphQlError[]): UnavailableService[] {
    const unavailable: UnavailableService[] = []
    for (const entry of raw) {
        const message = entry.message ?? 'The API reported an unspecified error'
        const rateError = entry.extensions?.rateError
        if (rateError === undefined) {
            throw new PirateShipRequestError(
                message,
                entry.extensions?.field ?? null
            )
        }
        unavailable.push({
            mailClassKey: (rateError.mailClassKey ?? '') as MailClassKey,
            packageTypeKey: (rateError.packageTypeKey ?? '') as PackageType,
            code: rateError.code ?? 0,
            title: rateError.title ?? '',
            reason: message,
        })
    }
    return unavailable
}

function buildVariables(options: ShippingOptions): Record<string, unknown> {
    const named = new Set<string>(ARGUMENTS.map(([name]) => name))
    const variables: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(options)) {
        if (value !== undefined && named.has(key)) variables[key] = value
    }
    return variables
}

/**
 * Quote shipping rates.
 *
 * Services are priced independently, so a partial result is normal: inspect
 * `errors` to learn what any missing service failed on.
 *
 * ```ts
 * const { rates, errors } = await fetchShippingRates({
 *     originZip: '43081',
 *     destinationZip: '90210',
 *     weight: 32,
 *     dimensionX: 9, dimensionY: 10, dimensionZ: 5,
 *     mailClassKeys: ['Priority', UpsDomesticService.Ground],
 *     packageTypeKeys: ['Parcel'],
 * })
 * ```
 *
 * @throws {PirateShipValidationError} An option was rejected before sending.
 * @throws {PirateShipHttpError} The API answered with a non-2xx status.
 * @throws {PirateShipNetworkError} The request never completed.
 */
export async function fetchShippingRates(
    options: ShippingOptions
): Promise<RateQuote> {
    validate(options)

    let response: Response
    const doFetch = options.fetch ?? globalThis.fetch
    try {
        response = await doFetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                operationName: 'RatesQuery',
                variables: buildVariables(options),
                query: QUERY,
            }),
            ...(options.signal !== undefined && { signal: options.signal }),
        })
    } catch (cause) {
        throw new PirateShipNetworkError(
            cause instanceof Error
                ? cause.message
                : 'The request could not be sent',
            { cause }
        )
    }

    if (!response.ok) {
        throw new PirateShipHttpError(
            response,
            await response.text().catch(() => '')
        )
    }

    type ResponseBody = {
        data?: { rates?: Rate[] | null }
        errors?: GraphQlError[]
    }
    let body: ResponseBody
    try {
        body = (await response.json()) as ResponseBody
    } catch (cause) {
        throw new PirateShipNetworkError('The API returned a malformed body', {
            cause,
        })
    }

    return {
        rates: body.data?.rates ?? [],
        unavailable: partitionErrors(body.errors ?? []),
    }
}
