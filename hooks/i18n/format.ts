// Number, plural and currency formatting for one language, through Intl. A locale file makes its
// own with `formatter('<code>')`. Each call falls back to plain English formatting if the runtime's
// Intl does not know the language, so a text never fails to show.

/** The forms of a word by plural category; `other` is required, the rest as the language has them. */
export type PluralForms = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;

export interface Format {
  /** The form of a word for `n` things, by the language's plural rules. */
  plural: (n: number, forms: PluralForms) => string;
  /** A whole or decimal number with the language's digits and separators. */
  number: (n: number) => string;
  /** A number with exactly `digits` decimals. */
  decimal: (n: number, digits: number) => string;
  /** An amount in US dollars, with the narrow symbol and two decimals. */
  usd: (n: number) => string;
}

function tryIntl<T>(make: () => T, fallback: () => T): T {
  try {
    return make();
  } catch {
    return fallback();
  }
}

const cache = new Map<string, Format>();

export function formatter(code: string): Format {
  const known = cache.get(code);
  if (known !== undefined) return known;
  const rules = tryIntl<Intl.PluralRules | undefined>(
    () => new Intl.PluralRules(code),
    () => undefined,
  );
  const numbers = new Map<number, Intl.NumberFormat | undefined>();
  const fixed = (digits: number) => {
    if (!numbers.has(digits)) {
      numbers.set(
        digits,
        tryIntl<Intl.NumberFormat | undefined>(
          () =>
            new Intl.NumberFormat(code, {
              minimumFractionDigits: digits,
              maximumFractionDigits: digits,
            }),
          () => undefined,
        ),
      );
    }
    return numbers.get(digits);
  };
  const plain = tryIntl<Intl.NumberFormat | undefined>(
    () => new Intl.NumberFormat(code, { maximumFractionDigits: 20, useGrouping: false }),
    () => undefined,
  );
  const money = tryIntl<Intl.NumberFormat | undefined>(
    () =>
      new Intl.NumberFormat(code, {
        style: 'currency',
        currency: 'USD',
        currencyDisplay: 'narrowSymbol',
      }),
    () => undefined,
  );
  const f: Format = {
    plural: (n, forms) => {
      const category = rules === undefined ? (n === 1 ? 'one' : 'other') : rules.select(n);
      return forms[category] ?? forms.other;
    },
    number: (n) => plain?.format(n) ?? String(n),
    decimal: (n, digits) => fixed(digits)?.format(n) ?? n.toFixed(digits),
    usd: (n) => money?.format(n) ?? `$${n.toFixed(2)}`,
  };
  cache.set(code, f);
  return f;
}
