# Synthetic provider fixtures

Everything here is synthetic. `../generate-issuer.mjs` writes these files; they describe no
real provider, plan or network.

- NPIs start with `19999` and fail the NPI check digit, so none can belong to a real
  provider.
- Plan IDs use the invented issuers `00010` to `00014`. Names, addresses and specialties say
  "Synthetic", and phone numbers use the 555-01xx range set aside for fiction.
- `truncated-tail.json` is a synthetic provider feed cut off mid-array, the way an
  interrupted download ends.

The records cover one individual with many addresses, one with plans in another state, a
facility with plans and addresses in several states, and a group. The plan definitions name
a network tier the records don't use.

Regenerate with `node tests/fixtures/qhp/generate-issuer.mjs`. Don't edit these files by hand.
