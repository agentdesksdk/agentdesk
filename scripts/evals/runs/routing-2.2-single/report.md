# AgentDesk routing stress evaluation

Run `routing-2.2-single` at 2026-09-03T01:59:59.155Z.

Catalog: 408 generated capabilities across 12 domains, seed 2026.
Task set `scripts/evals/routing/tasks/routing.v1.tasks.jsonl`, 55 held-out tasks, identical across every strategy.

Every figure below is runtime-measured and recomputable from the raw
records in this run's directory. No model was involved: the question is
what the router publishes for a messy phrasing, not what an agent then
does with it. `unavailable` means nothing observed the value.

| Metric | Deterministic (lexical, the shipped default) | Custom scorer (hierarchical, external) | Provenance |
| --- | --- | --- | --- |
| Expected capability in the routed set | 29.1% | 34.5% | measured |
| Rank of the expected capability, when routed (mean) | 2.56 | 2.16 | measured |
| Routed set size (mean) | 4.31 | 4.13 | measured |
| Schema bytes the routed set registers (mean) | 1,250 | 1,213 | measured |
| Tie at the cut | 74.5% | 52.7% | measured |
| Prompt overlap with the expected metadata (mean) | 0.08 | 0.08 | measured |

## What the current scorer gets wrong

### Deterministic (lexical, the shipped default)

39 of 55 tasks did not route their expected capability into the set of 5 the runtime would publish.

| Task | Prompt | Expected | Rank | Routed instead |
| --- | --- | --- | --- | --- |
| `order-cancel-unshipped` | Customer 4471 changed her mind about yesterday's purchase, it hasn't left the warehouse, please stop it going out | `cancel_shipment` | none in top six | `archive_customer`, `create_customer`, `create_customer_note`, `delete_customer`, `delete_customer_note` |
| `order-note-call` | Jot down on 10428 that the buyer rang and asked for delivery after the 15th | `create_order_note` | none in top six | `archive_customer`, `cancel_delivery`, `create_customer`, `delete_customer`, `export_customer` |
| `order-release-block` | The finance check on 88120 came back clean, let it go out again | `release_order_hold` | none in top six | `approve_inspection`, `close_inspection`, `get_inspection`, `list_inspection`, `refund_charge` |
| `shipping-where-is-parcel` | Where is parcel 1Z999 right now, the recipient says nothing has arrived | `get_tracking_number` | none in top six | `assign_shipment`, `cancel_shipment`, `create_shipment`, `export_shipment`, `find_shipment` |
| `shipping-carrier-switch` | Move the Hamburg deliveries off DHL and onto the courier we used before Christmas | `assign_carrier` | none in top six | `approve_stock_transfer`, `cancel_stock_transfer`, `approve_charge`, `approve_chargeback`, `approve_exchange` |
| `shipping-reschedule-drop` | Recipient on 77201 is away, push the drop to next Tuesday | `schedule_delivery` | none in top six | `archive_carrier`, `archive_category`, `archive_customer`, `archive_dashboard`, `archive_invoice` |
| `billing-refund-shipping` | The customer on 10428 says we charged her for delivery she never asked for, can we give that money back | `refund_shipping_fee` | none in top six | `archive_customer`, `create_customer`, `create_customer_note`, `delete_customer`, `delete_customer_note` |
| `billing-credit-for-late` | Give Acme a 200 credit against their next bill for the late delivery in March | `create_credit_note` | 6 | `approve_invoice`, `archive_invoice`, `cancel_credit_note`, `cancel_delivery`, `cancel_invoice` |
| `billing-void-wrong-vat` | INV-2291 went out with the wrong VAT, kill it and we'll raise a fresh one | `cancel_invoice` | none in top six | `create_address`, `create_api_key`, `create_backorder`, `create_carrier`, `create_category` |
| `billing-summaries-spreadsheet` | Finance wants the Q3 account summaries as a spreadsheet | `export_statement` | none in top six | `accounts_close_account`, `accounts_get_account`, `accounts_hold_account`, `accounts_release_account`, `assign_account` |
| `invoices-printable` | Send me the printable version of INV-2291 | `get_invoice_pdf` | none in top six | nothing |
| `invoices-sixty-days` | Acme have asked for 60 days on everything from now on instead of 30 | `update_payment_terms` | none in top six | nothing |
| `invoices-month-end-run` | Run the end-of-month invoicing for all subscription customers | `create_invoice_batch` | none in top six | `archive_customer`, `create_customer`, `create_customer_note`, `delete_customer`, `delete_customer_note` |
| `invoices-fold-two-bills` | Acme got two bills for the same delivery, fold them into one | `merge_invoice` | none in top six | `approve_invoice`, `archive_invoice`, `cancel_delivery`, `cancel_invoice`, `create_invoice` |
| `payments-bank-reversal` | The bank has reversed the 89.00 on order 55610 and wants our side of it by Friday | `update_chargeback` | none in top six | `archive_order`, `assign_order`, `create_order`, `create_order_export`, `create_order_hold` |
| `payments-partial-back` | Send 15.00 back to the card on 55610 for the missing item | `refund_payment` | none in top six | `create_order_line`, `create_payment_method`, `create_product`, `delete_order_line`, `delete_payment_method` |
| `payments-expired-visa` | Take the expired Visa off Maria's profile | `delete_payment_method` | none in top six | `accounts_close_account`, `accounts_get_account`, `accounts_hold_account`, `accounts_release_account`, `approve_charge` |
| `payments-proof-for-expenses` | Customer needs proof of the 89.00 they paid on the 3rd for their expenses | `get_receipt` | none in top six | `archive_customer`, `create_customer`, `create_customer_note`, `delete_customer`, `delete_customer_note` |
| `customers-same-person` | maria.k@example.com and mkowalski@example.com are the same person, tidy that up | `merge_contact` | none in top six | `find_contact`, `create_contact`, `delete_contact`, `find_account`, `find_address` |
| `customers-moved-offices` | Acme moved offices, their new place is 12 Harbour Street, Dublin 2 | `update_address` | none in top six | nothing |
| `customers-stop-marketing` | Maria says stop emailing her marketing | `update_consent` | none in top six | nothing |
| `customers-prefers-afternoon` | Log that Acme's buyer prefers to be called after 2pm | `create_customer_note` | none in top six | `archive_customer`, `create_customer`, `delete_customer`, `export_customer`, `find_customer` |
| `accounts-locked-out` | Jonas is locked out, reset his login credentials | `update_password` | none in top six | `accounts_close_account`, `accounts_get_account`, `accounts_hold_account`, `accounts_release_account`, `assign_account` |
| `accounts-offboard` | Priya left the company on Friday, make sure she can't get in anymore | `accounts_close_account` | none in top six | `accounts_get_account`, `get_account`, `get_address`, `get_api_key`, `get_backorder` |
| `accounts-sign-out-everywhere` | Sign Jonas out everywhere, his laptop was stolen | `delete_session` | none in top six | `approve_charge`, `approve_chargeback`, `approve_exchange`, `approve_inspection`, `approve_invoice` |
| `inventory-shift-stock` | Shift 40 of SKU-778 from Dublin to the Cork depot before Monday | `create_stock_transfer` | none in top six | `archive_warehouse`, `close_warehouse`, `create_warehouse`, `find_sku`, `find_warehouse` |
| `inventory-how-many` | How many of SKU-778 do we physically have across all sites | `get_stock_level` | none in top six | `archive_warehouse`, `close_warehouse`, `create_warehouse`, `find_sku`, `find_warehouse` |
| `catalog-price-from-december` | The blue hoodie should be 39.90 from the 1st of December | `schedule_price` | none in top six | nothing |
| `catalog-newsletter-code` | Set up a 15 percent code for the newsletter that runs the whole of Black Friday week | `create_discount` | none in top six | `find_sku`, `approve_invoice_batch`, `cancel_invoice_batch`, `create_invoice_batch`, `export_invoice_batch` |
| `catalog-discontinued-colour` | The red version of the hoodie is discontinued, hide it from the store | `archive_variant` | none in top six | nothing |
| `returns-does-not-fit` | Maria wants to send the hoodie from 10428 back, it doesn't fit | `create_return` | none in top six | `refund_charge`, `refund_payment`, `refund_shipping_fee` |
| `returns-let-money-go` | Warehouse confirmed the hoodie came back in good shape, let the money go out to Maria | `returns_approve_refund` | none in top six | `archive_warehouse`, `close_warehouse`, `create_warehouse`, `find_warehouse`, `get_warehouse` |
| `support-beyond-me` | This one is beyond me, hand it to someone in tier two | `create_escalation` | none in top six | `assign_account`, `assign_bin`, `assign_carrier`, `assign_escalation`, `assign_order` |
| `support-three-cases` | Maria opened three cases about the same hoodie, put them together | `merge_ticket` | none in top six | `archive_ticket`, `assign_ticket`, `close_ticket`, `create_ticket`, `delete_ticket` |
| `support-save-apology` | Save my apology-for-late-delivery text as something the team can reuse | `create_macro` | none in top six | `cancel_delivery`, `hold_delivery`, `list_delivery`, `reopen_delivery`, `schedule_delivery` |
| `support-bring-back-up` | Maria replied to the closed conversation, bring it back up | `reopen_ticket` | none in top six | `archive_ticket`, `assign_ticket`, `close_ticket`, `create_ticket`, `delete_ticket` |
| `reports-revenue-quarter` | How did revenue look last quarter compared with the one before | `get_sales_report` | none in top six | `export_sales_report`, `find_account`, `find_address`, `find_charge`, `find_contact` |
| `reports-weekly-email` | Email the weekly figures to the leadership list every Monday at 8 | `create_report_schedule` | none in top six | `list_contact`, `approve_report`, `archive_report`, `create_contact`, `create_report` |
| `reports-ops-screen` | Build a screen for the ops team with open orders and late deliveries on it | `create_dashboard` | none in top six | `get_order`, `returns_get_order`, `shipping_get_order`, `get_order_line`, `archive_order` |

### Custom scorer (hierarchical, external)

36 of 55 tasks did not route their expected capability into the set of 5 the runtime would publish.

| Task | Prompt | Expected | Rank | Routed instead |
| --- | --- | --- | --- | --- |
| `order-cancel-unshipped` | Customer 4471 changed her mind about yesterday's purchase, it hasn't left the warehouse, please stop it going out | `cancel_shipment` | none in top six | `update_warehouse`, `archive_warehouse`, `close_warehouse`, `create_warehouse`, `find_warehouse` |
| `order-note-call` | Jot down on 10428 that the buyer rang and asked for delivery after the 15th | `create_order_note` | none in top six | `cancel_delivery`, `hold_delivery`, `list_delivery`, `reopen_delivery`, `schedule_delivery` |
| `order-release-block` | The finance check on 88120 came back clean, let it go out again | `release_order_hold` | none in top six | `refund_charge`, `refund_payment`, `refund_shipping_fee`, `export_chargeback`, `export_credit_note` |
| `shipping-where-is-parcel` | Where is parcel 1Z999 right now, the recipient says nothing has arrived | `get_tracking_number` | none in top six | `hold_shipment`, `shipping_hold_shipment`, `assign_shipment`, `cancel_shipment`, `create_shipment` |
| `shipping-reschedule-drop` | Recipient on 77201 is away, push the drop to next Tuesday | `schedule_delivery` | none in top six | `archive_category`, `archive_invoice`, `archive_variant` |
| `shipping-rate-retire` | We're no longer offering the 2-day option to Ireland, take that tariff out of the list | `delete_shipping_rate` | none in top six | `list_shipping_rate`, `list_variant`, `archive_variant`, `list_carrier`, `list_category` |
| `billing-void-wrong-vat` | INV-2291 went out with the wrong VAT, kill it and we'll raise a fresh one | `cancel_invoice` | none in top six | `create_api_key`, `create_charge`, `create_credit_note`, `create_invitation`, `create_invoice` |
| `billing-summaries-spreadsheet` | Finance wants the Q3 account summaries as a spreadsheet | `export_statement` | none in top six | `accounts_close_account`, `accounts_get_account`, `accounts_hold_account`, `accounts_release_account`, `export_account` |
| `invoices-printable` | Send me the printable version of INV-2291 | `get_invoice_pdf` | none in top six | nothing |
| `invoices-sixty-days` | Acme have asked for 60 days on everything from now on instead of 30 | `update_payment_terms` | none in top six | nothing |
| `invoices-fold-two-bills` | Acme got two bills for the same delivery, fold them into one | `merge_invoice` | none in top six | `cancel_delivery`, `hold_delivery`, `list_delivery`, `reopen_delivery`, `schedule_delivery` |
| `payments-bank-reversal` | The bank has reversed the 89.00 on order 55610 and wants our side of it by Friday | `update_chargeback` | none in top six | `archive_order`, `assign_order`, `create_order`, `create_order_export`, `create_order_hold` |
| `payments-stop-settlement` | Thursday's settlement to the vendor should not go out at all, legal has blocked the whole contract | `cancel_payout` | none in top six | nothing |
| `payments-expired-visa` | Take the expired Visa off Maria's profile | `delete_payment_method` | none in top six | `accounts_release_account`, `accounts_close_account`, `accounts_get_account`, `accounts_hold_account`, `assign_account` |
| `customers-same-person` | maria.k@example.com and mkowalski@example.com are the same person, tidy that up | `merge_contact` | none in top six | `find_contact`, `create_contact`, `delete_contact`, `find_address`, `find_customer` |
| `customers-moved-offices` | Acme moved offices, their new place is 12 Harbour Street, Dublin 2 | `update_address` | none in top six | `create_stock_count`, `create_stock_transfer`, `create_warehouse`, `hold_stock_level`, `hold_stock_transfer` |
| `customers-stop-marketing` | Maria says stop emailing her marketing | `update_consent` | none in top six | nothing |
| `customers-prefers-afternoon` | Log that Acme's buyer prefers to be called after 2pm | `create_customer_note` | none in top six | `archive_customer`, `create_customer`, `delete_customer`, `export_customer`, `find_customer` |
| `customers-freeze-overdue` | Freeze everything for Acme until the overdue balance is cleared | `hold_customer` | none in top six | `accounts_hold_account`, `hold_api_key`, `hold_invoice`, `hold_user`, `delete_account` |
| `accounts-locked-out` | Jonas is locked out, reset his login credentials | `update_password` | none in top six | `accounts_close_account`, `accounts_get_account`, `accounts_hold_account`, `accounts_release_account`, `assign_account` |
| `accounts-offboard` | Priya left the company on Friday, make sure she can't get in anymore | `accounts_close_account` | none in top six | `accounts_get_account`, `get_api_key`, `get_billing_cycle`, `get_charge`, `get_invoice` |
| `accounts-sign-out-everywhere` | Sign Jonas out everywhere, his laptop was stolen | `delete_session` | none in top six | `approve_charge`, `approve_invoice`, `approve_price`, `approve_refund` |
| `inventory-shift-stock` | Shift 40 of SKU-778 from Dublin to the Cork depot before Monday | `create_stock_transfer` | none in top six | `find_sku`, `get_sku`, `update_sku` |
| `inventory-how-many` | How many of SKU-778 do we physically have across all sites | `get_stock_level` | none in top six | `find_sku`, `get_sku`, `update_sku` |
| `catalog-price-from-december` | The blue hoodie should be 39.90 from the 1st of December | `schedule_price` | none in top six | nothing |
| `catalog-newsletter-code` | Set up a 15 percent code for the newsletter that runs the whole of Black Friday week | `create_discount` | none in top six | `find_sku`, `get_sku`, `update_sku` |
| `catalog-discontinued-colour` | The red version of the hoodie is discontinued, hide it from the store | `archive_variant` | none in top six | nothing |
| `returns-does-not-fit` | Maria wants to send the hoodie from 10428 back, it doesn't fit | `create_return` | none in top six | `refund_charge`, `refund_payment`, `refund_shipping_fee` |
| `returns-let-money-go` | Warehouse confirmed the hoodie came back in good shape, let the money go out to Maria | `returns_approve_refund` | none in top six | `refund_charge`, `refund_payment`, `refund_shipping_fee` |
| `support-beyond-me` | This one is beyond me, hand it to someone in tier two | `create_escalation` | none in top six | `assign_account`, `assign_bin`, `assign_role`, `assign_user`, `merge_account` |
| `support-three-cases` | Maria opened three cases about the same hoodie, put them together | `merge_ticket` | none in top six | `hold_ticket`, `archive_ticket`, `assign_ticket`, `close_ticket`, `create_ticket` |
| `support-save-apology` | Save my apology-for-late-delivery text as something the team can reuse | `create_macro` | none in top six | `cancel_delivery`, `hold_delivery`, `list_delivery`, `reopen_delivery`, `schedule_delivery` |
| `support-bring-back-up` | Maria replied to the closed conversation, bring it back up | `reopen_ticket` | none in top six | `close_ticket`, `archive_ticket`, `assign_ticket`, `create_ticket`, `delete_ticket` |
| `reports-weekly-email` | Email the weekly figures to the leadership list every Monday at 8 | `create_report_schedule` | none in top six | `list_contact`, `get_contact`, `list_address`, `list_customer`, `list_customer_tag` |
| `reports-auditors-spreadsheet` | Pull the stock-on-hand numbers into a spreadsheet for the auditors | `export_inventory_report` | none in top six | `find_tracking_number`, `get_tracking_number`, `update_tracking_number`, `assign_carrier`, `assign_shipment` |
| `reports-ops-screen` | Build a screen for the ops team with open orders and late deliveries on it | `create_dashboard` | none in top six | `shipping_get_order`, `shipping_find_order`, `get_carrier`, `get_shipping_label`, `get_shipping_rate` |

## Reading this

The routed set is the first five the router returns, which is what
`find_capabilities` registers. The router was asked for six so the first
excluded score is visible; a tie at the cut means the fifth and sixth
scores were equal and codepoint order of the name decided what was
published. Rank is within those six; a capability the router never
returned has none.

Schema bytes are what the routed set would register, serialized the way
`ToolSurfaceManager` counts them, without the four bootstrap tools.

Prompt overlap is the share of a task's content tokens that appear in
the expected capability's name, intents, keywords, and domain. The task
set was authored from names and descriptions, not routing metadata, and
the loader refuses any task above the stated threshold, so this row is
the leakage rule enforced by a number.
