import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeHostTool as executeHostToolRaw } from "./host-tools.ts";

// The runner only calls executeHostTool after the local permissions.json allowed the action.
const executeHostTool = (req: Parameters<typeof executeHostToolRaw>[0]) =>
  executeHostToolRaw({ localDecision: "allow", ...req });
import { blockedDomain, checkComputerAction, luhnCardNumber, looksLikeIban } from "./payment-guard.ts";

const win = (title: string, wmClass = "Gedit") => ({ title, wmClass });

describe("payment guard", () => {
  it("blocks bank/payment domains in the window title", () => {
    for (const t of [
      "https://www.paypal.com/checkoutnow - Mozilla Firefox",
      "checkout.stripe.com/c/pay/cs_test - Chromium",
      "Satispay — app.satispay.com - Brave",
      "www.intesasanpaolo.com/login - Google Chrome",
      "my.unicredit.it - Firefox",
      "postepay.it | Area personale - Firefox",
    ]) {
      const d = checkComputerAction({ action: "computer-screenshot", window: win(t, "firefox") });
      assert.equal(d.ok, false, t);
    }
  });

  it("blocks bank/payment keywords (Italian and English)", () => {
    for (const t of ["Pagamento sicuro - Negozio", "Checkout | Shop", "Inserisci carta di credito", "Home Banking", "Bonifico SEPA", "Enter card number", "CVV"]) {
      assert.equal(checkComputerAction({ action: "computer-click", window: win(t) }).ok, false, t);
    }
  });

  it("fails closed when the focused window is unknown", () => {
    const d = checkComputerAction({ action: "computer-screenshot", window: null });
    assert.equal(d.ok, false);
  });

  it("fails closed for a browser whose URL can't be read from the title", () => {
    for (const cls of ["Navigator.firefox", "google-chrome.Google-chrome", "brave-browser.Brave-browser", "zen.zen"]) {
      const d = checkComputerAction({ action: "computer-click", window: win("Some page", cls) });
      assert.equal(d.ok, false, cls);
    }
    assert.equal(
      checkComputerAction({ action: "computer-click", window: win("docs.example.org/guide - Firefox", "Navigator.firefox") }).ok,
      true,
    );
  });

  it("allows ordinary non-browser windows", () => {
    for (const [t, c] of [["notes.txt - gedit", "gedit.Gedit"], ["Terminal", "gnome-terminal-server.Gnome-terminal"], ["zenity", "zenity.Zenity"]]) {
      assert.equal(checkComputerAction({ action: "computer-screenshot", window: win(t!, c!) }).ok, true, t);
    }
  });

  it("does not over-match lookalike words or domains", () => {
    assert.equal(blockedDomain("notpaypal.company.com/x"), null);
    assert.equal(blockedDomain("paypal.com.evil.example"), null);
    assert.equal(blockedDomain("www.paypal.com"), "paypal.com");
    assert.equal(checkComputerAction({ action: "computer-click", window: win("Banking-free notes", "gedit.Gedit") }).ok, false);
    assert.equal(checkComputerAction({ action: "computer-click", window: win("Bankrupt novel draft.odt", "libreoffice") }).ok, true);
  });

  it("refuses typing card numbers and IBANs", () => {
    assert.equal(luhnCardNumber("4111 1111 1111 1111"), true);
    assert.equal(luhnCardNumber("4111 1111 1111 1112"), false);
    assert.equal(looksLikeIban("IT60 X054 2811 1010 0000 0123 456"), true);
    const d = checkComputerAction({ action: "computer-type", window: win("notes - gedit"), typedText: "4111-1111-1111-1111" });
    assert.equal(d.ok, false);
    assert.equal(checkComputerAction({ action: "computer-type", window: win("notes - gedit"), typedText: "hello 2026" }).ok, true);
  });

  it("is applied by executeHostTool before any computer action", async () => {
    if (process.platform !== "linux") return;
    let reads = 0;
    for (const action of ["computer-screenshot", "computer-click", "computer-type", "computer-key", "computer-scroll"]) {
      const res = await executeHostTool({
        action,
        args: { x: 1, y: 1, text: "a", key: "Return" },
        computerUseGate: true,
        readWindow: () => {
          reads++;
          return { title: "https://www.paypal.com/signin - Mozilla Firefox", wmClass: "Navigator.firefox" };
        },
      });
      assert.equal(res.ok, false, action);
      if (!res.ok) {
        assert.equal(res.denied, true);
        assert.match(res.error, /banking\/payment/);
      }
    }
    assert.equal(reads, 5);
    const unknown = await executeHostTool({ action: "computer-screenshot", computerUseGate: true, readWindow: () => null });
    assert.equal(unknown.ok, false);
  });
});
