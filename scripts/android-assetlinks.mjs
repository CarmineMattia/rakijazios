#!/usr/bin/env node
// Print the Digital Asset Links file for the Rakijazios TWA.
//
//   node scripts/android-assetlinks.mjs <SHA256> [<SHA256> ...]
//
// Pass the SHA-256 certificate fingerprint of every key that signs an APK that
// should open full-screen (release key, Play App Signing key, optionally a
// debug key). Get one with:
//   keytool -list -v -keystore <keystore> -alias <alias> | grep SHA256
//   apksigner verify --print-certs app.apk | grep SHA-256
// Fingerprints are public; the keystore itself never goes in the repo.
// Serve the output at https://<host>/.well-known/assetlinks.json
// (patches/web/dist/.well-known/assetlinks.json; vite preview serves it as-is).
const PACKAGE = process.env.RAKIJAZIOS_ANDROID_PACKAGE || "app.rakijazios.twa";

function normalize(raw) {
  const hex = raw.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 64) throw new Error(`not a SHA-256 fingerprint: ${raw}`);
  return hex.match(/../g).join(":");
}

const prints = process.argv.slice(2);
if (prints.length === 0) {
  console.error("usage: node scripts/android-assetlinks.mjs <SHA256> [<SHA256> ...]");
  process.exit(2);
}
const statement = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: PACKAGE,
      sha256_cert_fingerprints: prints.map(normalize),
    },
  },
];
process.stdout.write(`${JSON.stringify(statement, null, 2)}\n`);
