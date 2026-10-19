# FAKE keys — simulator theater, not secrets

These two files are a published, hard-coded RSA keypair that plays the
role of "Nagad" in request/response encryption. They are committed to the
repo on purpose and must NEVER be used for anything except local
simulator development:

- Merchants encrypt request `sensitiveData` with
  `FAKE-nagad-sim-public.pem` (standing in for Nagad's real public key).
- The simulator decrypts with `FAKE-nagad-sim-private.pem`, verifies
  signatures against each app's own (fake) merchant public key, then
  encrypts responses with the merchant key and signs with this private key.

Because the private key is public, this crypto proves message SHAPE, not
identity. Never accept or store real Nagad keys here.

`FAKE-merchant-sim-*.pem` is the matching zero-setup merchant pair wired
into the default app's credentials, so the full encrypt/sign round trip
works without generating keys. Merchants testing their own key handling
generate their own FAKE pair and paste the public half into the app.
