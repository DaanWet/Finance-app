export const SETTING_KEYS = {
  WORK_ORG_ID: 'work_organization_id',
  SPLITWISE_API_KEY: 'splitwise_api_key',
  SPLITWISE_USER_ID: 'splitwise_user_id',
  GOOGLE_REFRESH_TOKEN: 'google_refresh_token',
  GOOGLE_ACCESS_TOKEN: 'google_access_token',
} as const;

export const TRANSACTION_TYPES = ['personal', 'reimbursable', 'income', 'savings'] as const;
export type TransactionType = typeof TRANSACTION_TYPES[number];

export const AUTO_REIMBURSEMENT_NOTE = 'Automatisch gedetecteerd';
export const REPAYMENT_NOTE = 'Terugbetaling';
