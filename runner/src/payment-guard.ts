/**
 * Banking / payment guard for computer control (screenshot, click, type, key, scroll).
 *
 * Before each action the focused window is read (X11: xdotool + xprop). The action is refused when
 *  - the window title, class or a URL found in the title matches the bank/payment/checkout denylist;
 *  - the focused window is a web browser and no URL can be read from its title (fail closed:
 *    browsers do not expose the page URL to the desktop, so a browser is only usable when an
 *    extension puts the URL in the title and that URL is not on the denylist);
 *  - the focused window cannot be determined at all (no X11 / xdotool, Wayland): fail closed;
 *  - computer-type text looks like a payment card number (Luhn-valid 13-19 digits) or an IBAN.
 * Limits: the guard sees titles and URLs, not page content, so a payment form on a page whose
 * title and URL look harmless is not detected.
 */
import { spawnSync } from "node:child_process";

export type FocusedWindow = { title: string; wmClass: string } | null;

export const BLOCKED_DOMAINS = [
  "paypal.com", "paypal.me", "stripe.com", "checkout.stripe.com", "buy.stripe.com", "satispay.com",
  "klarna.com", "scalapay.com", "revolut.com", "n26.com", "wise.com", "bunq.com", "hype.it",
  "nexi.it", "nexigroup.com", "adyen.com", "braintreepayments.com", "pay.google.com", "payments.google.com",
  "pay.amazon.com", "apple.com/apple-pay", "americanexpress.com", "visa.com", "mastercard.com",
  "poste.it", "postepay.it", "intesasanpaolo.com", "unicredit.it", "bancobpm.it", "bper.it", "mps.it",
  "fineco.it", "finecobank.com", "credem.it", "ing.it", "bnl.it", "bancaditalia.it", "mediolanum.it",
  "widiba.it", "chebanca.it", "ibanking", "homebanking", "onlinebanking", "sparkasse.de", "deutsche-bank.de",
  "commerzbank.de", "bnpparibas", "santander", "bbva", "hsbc", "barclays", "chase.com", "wellsfargo.com",
  "bankofamerica.com", "coinbase.com", "binance.com",
];

/** Lower-case keywords matched as whole words in titles. */
export const BLOCKED_KEYWORDS = [
  "bank", "banking", "banca", "banco", "bancomat", "home banking", "conto corrente",
  "payment", "payments", "pagamento", "pagamenti", "paga ora", "pay now", "checkout", "cassa",
  "carta di credito", "credit card", "debit card", "card number", "numero carta", "cvv", "cvc",
  "iban", "bonifico", "wire transfer", "paypal", "stripe", "satispay", "klarna", "scalapay",
  "postepay", "revolut", "wallet", "3d secure", "3ds", "secure payment", "pagamento sicuro",
];

const BROWSER_CLASS = /(firefox|librewolf|waterfox|chrom(e|ium)|brave|vivaldi|opera|microsoft-edge|msedge|epiphany|gnome-web|falkon|konqueror|midori|qutebrowser|tor ?browser|floorp|safari)|\bzen(-browser|-alpha|-beta)?\b/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const KEYWORD_RE = new RegExp(`(^|[^\\p{L}\\p{N}])(${BLOCKED_KEYWORDS.map(escapeRe).join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu");

export function urlsInText(text: string): string[] {
  return [...text.matchAll(/\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'<>]*)?)/gi)].map((m) => m[1]!);
}

export function blockedDomain(url: string): string | null {
  const lower = url.toLowerCase().replace(/^[a-z]+:\/\//, "");
  const host = lower.split(/[/:?#]/)[0]!;
  for (const d of BLOCKED_DOMAINS) {
    if (d.includes("/")) {
      if (lower.startsWith(d) || lower.includes(`.${d}`)) return d;
    } else if (d.includes(".")) {
      if (host === d || host.endsWith(`.${d}`)) return d;
    } else if (host.includes(d)) {
      return d;
    }
  }
  return null;
}

export function luhnCardNumber(text: string): boolean {
  for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

export function looksLikeIban(text: string): boolean {
  return /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/.test(text.toUpperCase());
}

export type GuardDecision = { ok: true } | { ok: false; reason: string };

export function checkComputerAction(input: {
  action: string;
  window: FocusedWindow;
  typedText?: string;
}): GuardDecision {
  const w = input.window;
  if (!w) {
    return { ok: false, reason: "Computer use refused: the focused window can't be determined (X11 + xdotool needed), so payment pages can't be ruled out." };
  }
  const hay = `${w.title} ${w.wmClass}`;
  const urls = urlsInText(w.title);
  for (const u of urls) {
    const d = blockedDomain(u);
    if (d) return { ok: false, reason: `Computer use refused: the focused window is a banking/payment site (${d}).` };
  }
  const kw = KEYWORD_RE.exec(hay);
  if (kw) return { ok: false, reason: `Computer use refused: the focused window looks like a banking/payment page ("${kw[2]}").` };
  if (BROWSER_CLASS.test(w.wmClass) && urls.length === 0) {
    return { ok: false, reason: "Computer use refused: the focused window is a browser and its page URL can't be read (fail closed)." };
  }
  if (input.action === "computer-type" && input.typedText) {
    if (luhnCardNumber(input.typedText)) return { ok: false, reason: "Computer use refused: the text looks like a payment card number." };
    if (looksLikeIban(input.typedText)) return { ok: false, reason: "Computer use refused: the text looks like an IBAN." };
  }
  return { ok: true };
}

/** X11 focused window (title + WM_CLASS). Null when it can't be determined. */
export function readFocusedWindow(env: NodeJS.ProcessEnv = process.env): FocusedWindow {
  if (process.platform !== "linux" || !env.DISPLAY) return null;
  const id = spawnSync("xdotool", ["getactivewindow"], { encoding: "utf8", timeout: 3_000 });
  const wid = id.status === 0 ? id.stdout.trim() : "";
  if (!/^\d+$/.test(wid)) return null;
  const title = spawnSync("xdotool", ["getwindowname", wid], { encoding: "utf8", timeout: 3_000 });
  if (title.status !== 0) return null;
  const cls = spawnSync("xprop", ["-id", wid, "WM_CLASS"], { encoding: "utf8", timeout: 3_000 });
  const wmClass = cls.status === 0 ? (cls.stdout.split("=")[1] ?? "").replace(/"/g, "").trim() : "";
  return { title: title.stdout.trim(), wmClass };
}
