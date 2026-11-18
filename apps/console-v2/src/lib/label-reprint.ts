import { getLookups } from '@/lib/api';

export interface LabelReprintReasonOption {
  value: string;
  label: string;
  isDefault?: boolean;
  rank?: number;
}

export function labelReprintReasonOptions(): LabelReprintReasonOption[] {
  return [...(getLookups('label_reprint_reason') ?? [])]
    .filter((row) => typeof row.value === 'string' && row.value.trim().length > 0)
    .sort((a, b) => Number(a.rank ?? 999) - Number(b.rank ?? 999))
    .map((row) => ({
      value: row.value,
      label: row.label || row.value,
      isDefault: row.is_default === true,
      rank: row.rank,
    }));
}

export function defaultLabelReprintReason(): string | null {
  const options = labelReprintReasonOptions();
  return options.find((option) => option.isDefault)?.value ?? options[0]?.value ?? null;
}
