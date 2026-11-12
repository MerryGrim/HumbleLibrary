# Synchronization contract

Modern synchronization represents Humble's **Bundles** collection and any explicitly linked current Choice purchase. A tile is a purchase container; its contents are keys and downloads. A content row from the website's separate **Purchased** tab is not a bundle.

Authentication and reveal/export remain separate from synchronization. Synchronization reads documents only. It does not reveal keys, redeem entitlements, sign downloads, submit purchases or retry a reveal.

## Authoritative grouping

The canonical `/home/library` document supplies `UserLibrary.bundleItems`. This is the official Bundles-tab index. Each indexed parent keeps its supplied title and opens this exact route:

```js
`/home/library/${item.productEntitlementId ?? item.id}`
```

The index's `entitlements` are shallow wrappers, not a list of the bundle's products. Read the parent route and aggregate every `ProductKeysDownloads` component, including every key and download in each component. Preserve all platforms, redemption instructions, gift states and unavailable items. Identical entitlement records may be deduplicated; conflicting records must not silently replace one another.

Index parsing consumes only the canonical route ID, title and an optional explicit purchase date. The canonical ID is `productEntitlementId ?? id`; an unused fallback ID does not override a valid product-entitlement ID. Wrapper entitlements, `itemType`, `collection` and unrelated references are not decoded or validated. Aliases for the same canonical route produce one parent destination, never separate product tiles. Malformed lists, route IDs or titles still reject the index.

The same `UserLibrary` component separately passes `subscriptionEntitlement` to its Choice carousel. The carousel links directly to `/home/library/${subscriptionEntitlement.id}`. When this optional container is present, the adapter consumes only its validated ID and reads that exact parent route. It deduplicates an alias already present in `bundleItems`. A single unambiguous detail heading supplies its title; absent or conflicting child headings use the neutral name **Humble Choice**. Every returned key/download section remains inside that purchase.

Do not create parent tiles from `filterUserLibrary` results, content routes, entitlement groups or Vault entries. Do not infer parents from titles, product names, a shared `collection` value or an assumed relationship between similarly named IDs. Synchronization does not enumerate the Purchased tab or discover its filter action. A deployment's server-action IDs are not needed for this read path.

A missing purchase date stays missing unless a valid date is supplied by the detail response or a matching cached bundle. The adapter does not derive dates from titles or substitute the current time.

## One job

1. Read a fresh canonical `/home/library` document. Passively parse its authenticated provider, Bundles index and optional current Choice purchase-container ID.
2. Validate and plan one canonical detail destination for each indexed bundle. Keep the parent identity, title and source route together.
3. Read each bundle destination sequentially. Verify the same authenticated account and normalize all returned key/download sections into that parent. An unavailable detail becomes an explicitly incomplete bundle, rather than an empty or separate product tile.
4. Recheck the authenticated account after the last read.
5. Validate the entire grouped result natively, preserve eligible cached keys, and save one encrypted snapshot. Check cancellation immediately before committing.

`humble_sync.js` owns scheduling, cancellation, deadlines and read retries. `humble_bridge.js` owns same-origin transport and the parent/content projection. The passive page/Flight parsers do not execute downloaded scripts. Native Rust owns validation, account-bound migration/merging and Windows DPAPI persistence.

## Failures and load control

- Reads remain sequential. Index and final identity verification use a one-second gap. Healthy bundle-detail GETs use a 200 ms gap. Retryable detail failures raise that gap to at least one second, doubling up to five seconds; each group of five successful detail GETs halves it toward 200 ms. These are application load policies, not documented Humble rate limits.
- Each read has a 30-second deadline and at most four attempts. Retry delays are 2, 5 and 15 seconds; a bounded `Retry-After` can extend a delay to 60 seconds.
- Network loss and HTTP 408/429/5xx can be retried. HTTP 200 alone is not proof of a usable bundle document. Malformed documents are not accepted as empty bundles.
- Authentication failure and cancellation terminate the job. A failed read does not reopen a sign-in window.
- The parent index and the contents have separate completeness requirements. A partial result cannot claim a complete refresh or advance its timestamp. Detail failures are isolated and retain matching cached keys for the affected parent.
- Exhausted throttling, or three consecutive exhausted transient detail failures, opens a circuit for remaining network detail reads. Each affected indexed parent remains visibly incomplete. The next explicit refresh starts a new job.
- Bounded activity events keep the native inactivity watchdog alive. A silent job times out after 90 seconds; an absolute two-hour cap remains. Late responses and cancelled job generations cannot commit.

## Persistence, migration and identity

The account binding is a SHA-256 namespace digest of the authenticated provider's opaque account ID. The raw ID stays inside the adapter and is excluded from serialized parser projections. Neither the raw ID nor its digest belongs in diagnostics or the application UI.

Schema-3 snapshots use the private `sourceProjection: "bundles-v1"` marker and retain completeness and the time of the last complete refresh, protected with DPAPI. Older snapshots can contain the incorrect per-content tile projection. Those content rows must not remain visible as bundles, including before the first new refresh. Migration archives the old snapshot and preserves its previously revealed values in a private encrypted `retainedLicenses` pool. A newly fetched entitlement can recover a retained value only through an exact **parent bundle ID and entitlement ID** match within the same bound account, with all scoped candidates agreeing. The optional `parentId` is populated only from a validated canonical parent; older unscoped entries remain protected privately and cannot be injected into a newly discovered parent. Fresh metadata remains authoritative; titles are never a join key. Unmatched values remain encrypted and do not become invented bundle cards. Unbound and differently bound snapshots cannot transplant values into a newly synchronized account. The projection marker, account binding and retained pool do not enter the frontend status DTO.

After sign-in or a failed refresh, hidden modern keys require an accepted identity-bound synchronization before revealing. Already cached key values remain available in their verified parent. This prevents a stale cache from accepting another account's reveal result.

Full Humble-data reset clears the local library, browser profile and application-owned encrypted migration archives. Exports and interface preferences remain separate.

## First-party source evidence

The following references identify the saved official client build used for the adapter review. Offsets are JavaScript string-character offsets in the minified files, not stable identifiers for later deployments. The adjacent symbols and snippets are the useful anchors.

| Saved first-party script | Offset / anchor | Established behavior |
| --- | --- | --- |
| `0vu0ik72wero9.js` | around 528312, `UserLibrary` / `bundleItems:P` | The component receives Bundles separately from Purchased and Vault, and renders `rF` with `P` for the Bundles tab. |
| `0vu0ik72wero9.js` | around 526545, `rW` | Bundle rows use `item.title` and link to `/home/library/${item.productEntitlementId ?? item.id}`. |
| `0vu0ik72wero9.js` | around 517606, `UserLibraryRow` | Purchased rows have independent content/group/gift navigation. They are not the Bundles index. |
| `3lb8lkf8oktuz.js` | around 12100, `UserLibraryRowLayout` | A content-row `id` defaults to `/home/library/content/${id}`; this differs from the bundle route. |
| `2mavdnry8mv01.js` | around 21333, `ProductKeysDownloads` | The detail component consumes `userLibraryItem`, renders its title, and reads its `entitlements.keys`, `entitlements.downloads` and redemption groups. `productEntitlementId` supplies optional bulk-download context. |
| `0vu0ik72wero9.js` | around 530295, `subscriptionEntitlement:r??null` | `UserLibrary` supplies the separate current Choice entitlement to `ChoiceGamesMarketingCarousel`. |
| `0zt0-o49yzi9d.js` | around 21100, `ChoiceMediaCarousel` / `S=d?` | The current Choice redemption destination is `/home/library/${subscriptionEntitlement.id}`. |

The saved root rows have only shallow entitlement wrappers. In the separately saved opened-bundle DOM, the same parent title heads many rendered content rows. This establishes why root wrappers and Purchased rows cannot substitute for reading the bundle's detail document. No saved client code establishes a universal Purchased-to-parent join through `collection` or `productEntitlementId`.

The Bundles index is not evidence that every historical Choice month, storefront purchase or old order has been enumerated. Purchased rows explicitly include Choice-specific display behavior (`subscriptioncontent` and `choiceDate`, around offset 518274 in `0vu0ik72wero9.js`), but their normal navigation is a content route; only the gifted branch uses `productEntitlementId` as a parent destination. The saved code does not establish a universal historical Purchased-to-order mapping. Original local purchase groups therefore remain the provenance for recovered legacy values; matching names, dates or an entitlement ID alone must not relocate them into a modern parent. The optional current Choice link adds only that explicit container and does not resolve historical coverage.

## Verification boundary

Saved HTML and first-party scripts are inspected as inert data. They are never mounted, bootstrapped or allowed to make network requests. The opened-bundle HTML was saved after client navigation: its rendered DOM is the bundle detail, but its inline Flight stream still contains the earlier library root. It therefore cannot serve as a complete fixture for the detail DTO or prove a particular live account's contents.

Synthetic parser, coordinator, browser and native fixtures verify grouping, all-section aggregation, retries, cancellation, migration and persistence. They do not establish successful synchronization of a real Humble account. Earlier HTTP 200 failures do not by themselves prove a rate limit. The corrective contract is the official Bundles index plus bundle details; pacing does not repair an incorrect parent/content model.

## Explicit legacy recovery

An encrypted recovery inbox is separate from the active cache, so older installed versions can ignore a prepared recovery until the application update. Import is a local action on user-selected DPAPI library copies. The target account must match the current grouped library; differently bound sources are rejected. An unbound old copy requires the explicit recovery action. No account ownership is inferred from matching names or keys.

Each private recovery record keeps the source ciphertext digest, original source-account marker and full original parent bundle and items. Import order determines metadata precedence; source versions and different key values remain protected. Consumption archives the active snapshot and commits the recovered records atomically before removing the inbox. A repeated inbox is idempotent, and full data reset removes both the recovered records and pending inbox.

The frontend receives a local-copy view grouped by exact original purchase identity. It preserves every original parent membership and distinct (item ID, code bytes) pair while suppressing keys already visible in current modern bundles. Local-copy records support copy/export only and never submit reveal requests or become guessed modern bundle members. Sync retains recovery for the same account; changing accounts archives it and removes it from the visible library.