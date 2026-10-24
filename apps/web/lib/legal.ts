/**
 * Everything the Terms, the Privacy Notice, security.txt and the footer say about who runs
 * Orientim, in one place. Fill these in, set `reviewedByLawyer` once a lawyer has approved the texts,
 * and the pages are final: nothing else needs to change.
 *
 * An empty field is shown on the pages as its placeholder in brackets, and the Draft banner stays.
 */
export const LEGAL = {
  /**
   * Who runs Orientim: a person in their own name ('individual') until a company is registered, then
   * the company ('company'), with `registration` filled in.
   */
  operator: 'individual' as 'individual' | 'company',
  /** The person, or the company as registered: 'Orientim SHPK'. */
  entity: 'Qazim Memeti',
  /** A company's type and registry number: 'a limited liability company (SHPK), NUIS L12345678A'. Not used for a person. */
  registration: '',
  /**
   * Where the operator lives or is registered: 'North Macedonia'. Also the governing law, unless
   * `governingLaw` says otherwise, and the data protection authority the Privacy Notice names.
   */
  country: 'North Macedonia',
  /** The operator's address (a company's registered office). */
  address: '',

  /** Where people write for help. */
  supportEmail: '',
  /** Legal notices and disputes; the support address when empty. */
  legalEmail: '',
  /** Requests about personal data; the legal address when empty. */
  privacyEmail: '',
  /** Vulnerability reports (also in /.well-known/security.txt); the support address when empty. */
  securityEmail: '',

  /** The law that governs the Terms; the country's when empty. */
  governingLaw: '',
  /** Disputes: 'the Singapore International Arbitration Centre (SIAC)', or the courts of a city. */
  disputeForum: 'the competent courts of North Macedonia',
  /** Where arbitration is seated, or the courts sit: 'Singapore', 'Tirana'. */
  disputeSeat: '',

  /** The total cap on liability in the Terms, section 15, in US dollars. */
  liabilityCapUsd: 100,
  /** How many days the hosting provider keeps request logs (it depends on the hosting plan). */
  logRetentionDays: '',

  /** The date the texts take effect, as shown at the top of each page: '1 November 2026'. */
  lastUpdated: '24 October 2026',
  /** true once a lawyer has approved the Terms and the Privacy Notice; removes the Draft banner. */
  reviewedByLawyer: false,
};

/** A field's value, or its placeholder while it is empty. */
export function legal(field: 'entity' | 'registration' | 'country' | 'address' | 'supportEmail' | 'legalEmail' | 'privacyEmail' | 'securityEmail' | 'governingLaw' | 'disputeForum' | 'disputeSeat' | 'logRetentionDays'): string {
  const fallback: Partial<Record<typeof field, string>> = {
    legalEmail: LEGAL.supportEmail,
    privacyEmail: LEGAL.legalEmail || LEGAL.supportEmail,
    securityEmail: LEGAL.supportEmail,
    governingLaw: LEGAL.country,
  };
  const value = LEGAL[field] || fallback[field] || '';
  return value || `[${PLACEHOLDER[field]}]`;
}

const PLACEHOLDER = {
  entity: 'company name', registration: 'company type and registration number', country: 'country', address: 'registered address',
  supportEmail: 'support email', legalEmail: 'legal email', privacyEmail: 'privacy email', securityEmail: 'security email',
  governingLaw: 'governing law', disputeForum: 'arbitration institution or courts', disputeSeat: 'seat', logRetentionDays: 'number of',
} as const;

/** Whether every field the pages need is filled in. */
export const legalComplete = [LEGAL.entity, ...(LEGAL.operator === 'company' ? [LEGAL.registration] : []), LEGAL.country, LEGAL.address, LEGAL.supportEmail, LEGAL.disputeForum, LEGAL.disputeSeat, LEGAL.logRetentionDays]
  .every(v => v.trim().length > 0);

/** The Draft banner stays until the texts are complete and a lawyer has approved them. */
export const legalDraft = !(legalComplete && LEGAL.reviewedByLawyer);
