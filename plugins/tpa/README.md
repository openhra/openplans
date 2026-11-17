# Answer receipts

`@openplans/plugin-tpa` exports ICHRA census answers for a private installation. It is off by default. It has no database tables, lookup route, schedules, events or outbound requests.

The host registers `POST /tpa/receipts/prepare` only with `tpa.enabled` and `tpa.privateIngress` both true and this plugin explicitly loaded. The route requires the operator bearer token. Keep it behind private ingress with body capture disabled. No route or tool is offered on the shared public installation.

Send `operation: "prepare_from_batch"`, `batch_request` with the existing census `rows`, and optionally `include_input_bundle: true`. The response is a JSON attachment. By default it contains input hashes and exact answer bytes, without raw inputs. The optional replay bundle contains the caller's inputs. Both exports are sensitive. Keep downloads under your own records policy. OpenPlans holds the request in memory and stores no receipt, input, digest or answer.

Build core, then run:

```sh
node dist/receipts/cli.js receipt.json --inputs inputs.json --snapshots restored-files.json
```

`inputs.json` is the original batch request. Omit it when the receipt includes `input_bundle`. `restored-files.json` maps each file snapshot ID to an absolute local file path. Aggregate catalog snapshots list their ordered member hashes; the verifier rebuilds those manifests from the verified child files. The verifier streams and hashes those bytes. It never downloads files or imports data. The manifest conservatively lists all active snapshots, including completeness evidence. Keep the pinned public files and the exact engine build if you need replay later.

To reproduce the answer, restore the pinned public files into a disposable local Postgres database with the same snapshot IDs and data generation. Set `OPENPLANS_REPLAY_DATABASE_URL` to its loopback connection and add `--replay`. The command does not load the application's database configuration. It refuses remote database hosts and URL options. The database session used for calculations is read-only. Never point it at a serving installation.

Exit 0 means the answer was reproduced byte for byte. Exit 1 means verification failed. Exit 2 means replay is unavailable, with a reason such as `inputs_required`, `snapshot_missing`, `restored_generation_mismatch` or `replay_adapter_required`. A successful manifest check alone does not claim the calculation was reproduced. Source and built engines have different hashes. Replay requires the same build form, code, dependency lock and Node version. Missing dependencies remain unavailable.

Digests detect changes. They are not signatures, proof of correct caller inputs, or proof that the original calculation was correct. Anyone who changes the artifact and recomputes every digest can create a different receipt. There is no automatic retention, file restoration or stored receipt lookup.
