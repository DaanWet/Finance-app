const eurFormatter = new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR' });
const dateOptions: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' };

export function formatEur(amount: number): string {
  return eurFormatter.format(amount);
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('nl-BE', dateOptions);
}

export function typeBadge(type: string): string {
  const map: Record<string, string> = {
    personal: 'Persoonlijk',
    reimbursable: 'Terugbetaalbaar',
    income: 'Inkomst',
    savings: 'Sparen',
  };
  return map[type] ?? type;
}
