# Tributary: Compare, Merge & Approve Flows

Tributary is a Salesforce app for admins who work on flows. It runs inside Salesforce and gives you:

- a **visual diff** of any two flows or flow versions, in this org or another one: the flow drawn as a canvas, with added, removed and changed elements, connectors and fields highlighted, plus an XML view;
- a **visual merge**: take elements, paths, single fields or whole groups from either side, map one flow's inputs onto another's, and save the result as a new **inactive** version;
- **activation governance**: each governed flow has an owner. Activations go through the owner's approval, and in Watch or Locked mode an activation that skipped approval is detected and reverted.

Tributary was built as a managed package for AppExchange (namespace `trib`). That release was cancelled, so it is published here as source, as is. It has been deployed and tested in Developer Edition orgs, but never installed as a package, and it is not maintained.

## Documentation

| Document                                       | For                                                        |
| ---------------------------------------------- | ---------------------------------------------------------- |
| [`docs/setup.md`](docs/setup.md)               | Installing and configuring Tributary in an org             |
| [`docs/walkthrough.md`](docs/walkthrough.md)   | A guided tour for a new admin                              |
| [`docs/architecture.md`](docs/architecture.md) | What it does and how the code is laid out                  |
| [`docs/security.md`](docs/security.md)         | Where data goes, how it authenticates, and who may do what |
| [`docs/performance.md`](docs/performance.md)   | How the engines scale with flow size                       |
| [`test/e2e/README.md`](test/e2e/README.md)     | Browser tests, seeded test flows and help-video recording  |

## Development

You need Node.js and the Salesforce CLI (`sf`). The source in `force-app/` is written for the `trib` package. `scripts/deploy-to.sh` deploys it to any org you have authorised with `sf org login`, by rewriting a private copy for that org's My Domain and namespace. It then runs the six Apex test classes:

```sh
npm ci
npm test                                    # LWC Jest tests
npm run lint                                # ESLint
scripts/deploy-to.sh <org-alias> --dry-run  # compile and run the Apex tests without saving
scripts/deploy-to.sh <org-alias>            # deploy
```

After deploying, follow [`docs/setup.md`](docs/setup.md) to create the connected app and point the credential at the org.

## Licence

Tributary is released under the [MIT licence](LICENSE). See [`NOTICE`](NOTICE) for the Salesforce Lightning Design System icon attribution.
