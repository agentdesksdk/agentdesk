# AgentDesk routing stress evaluation

Run `routing-holdout-2` at 2026-09-03T01:39:38.823Z.

Catalog: 408 generated capabilities across 12 domains, seed 7.
Task set `scripts/evals/routing/tasks/routing.v2.tasks.jsonl`, 55 held-out tasks, identical across every strategy.

Every figure below is runtime-measured and recomputable from the raw
records in this run's directory. No model was involved: the question is
what the router publishes for a messy phrasing, not what an agent then
does with it. `unavailable` means nothing observed the value.

| Metric | Deterministic (lexical, the shipped default) | Hybrid (lexical plus graph and session) | Custom scorer (hierarchical, external) | Provenance |
| --- | --- | --- | --- | --- |
| Expected capability in the routed set | 29.1% | 27.3% | 36.4% | measured |
| Rank of the expected capability, when routed (mean) | 1.88 | 2.40 | 1.85 | measured |
| Routed set size (mean) | 3.93 | 4.16 | 4.11 | measured |
| Schema bytes the routed set registers (mean) | 1,152 | 1,200 | 1,212 | measured |
| Tie at the cut | 61.8% | 54.5% | 54.5% | measured |
| Prompt overlap with the expected metadata (mean) | 0.10 | 0.10 | 0.10 | measured |

## What the current scorer gets wrong

### Deterministic (lexical, the shipped default)

39 of 55 tasks did not route their expected capability into the set of 5 the runtime would publish.

| Task | Prompt | Expected | Rank | Routed instead |
| --- | --- | --- | --- | --- |
| `o2-stop-order` | Ravi rang, he ordered the wrong size on 31877, kill the whole thing before it gets picked | `cancel_order` | none in top six | `get_variant`, `accounts_get_account`, `archive_variant`, `create_variant`, `delete_variant` |
| `o2-merge-double` | Same customer placed 31877 and 31878 within a minute for the same address, make them one | `merge_order` | none in top six | `archive_customer`, `create_address`, `create_customer`, `create_customer_tag`, `delete_address` |
| `o2-backorder-release` | The restock for the blue hoodie landed, let the people waiting on it have theirs now | `release_backorder` | none in top six | `approve_restock`, `cancel_restock`, `create_restock` |
| `o2-note-gift` | Add to 31877 that it's a birthday gift and shouldn't show the price on the slip | `create_order_note` | none in top six | `list_price`, `approve_price`, `create_account`, `create_address`, `create_api_key` |
| `s2-hold-parcel` | Don't let the Berlin parcel for 31877 leave until the customer confirms she's home Thursday | `shipping_hold_shipment` | none in top six | `archive_customer`, `create_customer`, `create_customer_tag`, `delete_customer`, `delete_customer_note` |
| `s2-rate-change` | The 48 hour option for Ireland goes up to 9.90 from Monday | `update_shipping_rate` | none in top six | `archive_variant`, `create_variant`, `delete_variant`, `find_account`, `find_address` |
| `s2-tracking-lookup` | The customer pasted 1Z7F2 into the chat, which order is that | `find_tracking_number` | none in top six | `archive_customer`, `archive_order`, `assign_order`, `cancel_order`, `create_customer` |
| `s2-delivery-slot` | Ravi can only take the delivery after six, push the slot back | `update_delivery` | none in top six | `assign_bin`, `cancel_delivery`, `get_bin`, `get_delivery`, `hold_delivery` |
| `b2-hold-invoice` | Park INV-4410 until legal has looked at the wording | `hold_invoice` | none in top six | nothing |
| `b2-cycle-move` | Move Acme from monthly to quarterly invoicing starting January | `update_billing_cycle` | none in top six | `approve_stock_transfer`, `create_stock_transfer`, `get_stock_transfer`, `hold_stock_transfer`, `list_stock_transfer` |
| `i2-remove-line` | Take the second row off INV-4410, the sample was free | `delete_invoice_line` | none in top six | `approve_chargeback`, `approve_credit_note`, `approve_exchange`, `approve_inspection`, `approve_invoice` |
| `i2-reopen` | INV-4410 was closed by mistake, open it back up so I can fix the PO number | `reopen_invoice` | none in top six | `find_order`, `find_tracking_number`, `get_tracking_number`, `accounts_get_account`, `archive_order` |
| `p2-partial-back` | Give Ravi 12.50 of the 89.00 back, one item was missing from the box | `refund_payment` | none in top six | `archive_product`, `create_product`, `delete_order_line`, `export_product`, `get_order_line` |
| `p2-payout-schedule` | Pay the vendor for October on the 15th instead of the 30th | `schedule_payout` | none in top six | `refund_charge`, `refund_payment`, `refund_shipping_fee` |
| `p2-hold-payment` | Don't settle Ravi's 89.00 yet, fraud wants a look first | `hold_payment` | none in top six | `find_account`, `find_address`, `find_charge`, `find_customer`, `find_invoice` |
| `c2-merge-dupes` | Acme Ltd and ACME Limited are the same company, fold them into one record | `merge_customer` | none in top six | nothing |
| `c2-tag` | Mark everyone who bought the hoodie as a VIP | `create_customer_tag` | none in top six | nothing |
| `c2-release` | Acme paid what they owed, lift the freeze on their account | `release_customer` | none in top six | `accounts_hold_account`, `hold_account`, `accounts_get_account`, `accounts_release_account`, `accounts_update_account` |
| `c2-address-find` | Which of our customers are at 12 Harbour Street | `find_address` | none in top six | `archive_customer`, `create_customer`, `create_customer_tag`, `delete_customer`, `delete_customer_note` |
| `a2-new-user` | Get Priya's replacement set up with a login before Monday | `create_user` | none in top six | `accounts_get_account`, `find_account`, `accounts_hold_account`, `accounts_release_account`, `accounts_update_account` |
| `a2-sessions` | Where is Jonas logged in right now | `list_session` | none in top six | nothing |
| `v2-transfer-approve` | The 40 units heading to Cork can go, I've checked the paperwork | `approve_stock_transfer` | none in top six | nothing |
| `v2-reorder-new` | Start auto-reordering the hoodie at 30 units | `create_reorder_point` | none in top six | nothing |
| `v2-warehouse-find` | Which site holds the overflow stock for Ireland | `find_warehouse` | none in top six | `hold_stock_level`, `hold_stock_transfer`, `accounts_hold_account`, `approve_stock_count`, `approve_stock_transfer` |
| `k2-price-approve` | The 39.90 for the hoodie is agreed, make it live | `approve_price` | none in top six | nothing |
| `k2-discount-schedule` | Turn the newsletter code on for Black Friday week only | `schedule_discount` | none in top six | `find_sku`, `get_sku` |
| `k2-product-hold` | Pull the hoodie from the shop until the recall is sorted | `hold_product` | none in top six | `export_account`, `export_chargeback`, `export_credit_note`, `export_customer`, `export_inventory_report` |
| `k2-variant-new` | We're adding an XXL in the blue hoodie | `create_variant` | none in top six | nothing |
| `r2-exchange-new` | Ravi wants a medium instead of the large he got | `create_exchange` | none in top six | nothing |
| `r2-label` | Send Ravi something to stick on the box so he can post it back free | `create_return_label` | none in top six | `refund_charge`, `refund_payment`, `refund_shipping_fee` |
| `r2-refund-approve` | The hoodie came back clean, release Ravi's money | `returns_approve_refund` | none in top six | `accounts_release_account`, `refund_charge`, `refund_payment`, `refund_shipping_fee`, `release_account` |
| `r2-restock-cancel` | Don't put the returned hoodie back on the shelf, it's damaged | `cancel_restock` | none in top six | `assign_bin`, `get_bin`, `list_bin`, `refund_charge`, `refund_payment` |
| `t2-escalate-assign` | Give the Acme escalation to Priya, she knows their account | `assign_escalation` | none in top six | `accounts_get_account`, `accounts_hold_account`, `accounts_release_account`, `accounts_update_account`, `close_account` |
| `t2-macro-archive` | Retire the old shipping-delay reply, we don't use it anymore | `archive_macro` | none in top six | `archive_shipping_rate`, `archive_carrier`, `create_shipping_label`, `delete_shipping_label`, `delete_shipping_rate` |
| `t2-survey` | How did Ravi rate the last conversation | `get_satisfaction_survey` | none in top six | `archive_shipping_rate`, `archive_ticket`, `assign_ticket`, `close_ticket`, `create_ticket` |
| `t2-reply-edit` | I made a typo in my last reply to Ravi, fix the amount to 12.50 | `update_reply` | none in top six | `approve_price`, `delete_reply`, `get_price`, `get_reply`, `list_price` |
| `p2-inventory-schedule` | Every Monday morning I want the stock figures in my inbox | `schedule_inventory_report` | none in top six | `approve_report`, `approve_stock_count`, `approve_stock_transfer`, `archive_report`, `cancel_stock_count` |
| `p2-report-hold` | Don't publish the Q3 numbers yet, the CFO hasn't signed them off | `hold_report` | none in top six | `approve_chargeback`, `approve_credit_note`, `approve_exchange`, `approve_inspection`, `approve_invoice` |
| `p2-sales-list` | Which revenue breakdowns did we run this quarter | `list_sales_report` | none in top six | `approve_invoice_batch`, `cancel_invoice_batch`, `create_invoice_batch`, `create_sales_report`, `export_invoice_batch` |

### Hybrid (lexical plus graph and session)

40 of 55 tasks did not route their expected capability into the set of 5 the runtime would publish.

| Task | Prompt | Expected | Rank | Routed instead |
| --- | --- | --- | --- | --- |
| `o2-stop-order` | Ravi rang, he ordered the wrong size on 31877, kill the whole thing before it gets picked | `cancel_order` | none in top six | `get_variant`, `get_sku`, `delete_variant`, `get_delivery`, `get_reminder` |
| `o2-merge-double` | Same customer placed 31877 and 31878 within a minute for the same address, make them one | `merge_order` | none in top six | `get_contact`, `get_address`, `get_account`, `get_customer_note`, `list_contact` |
| `o2-backorder-release` | The restock for the blue hoodie landed, let the people waiting on it have theirs now | `release_backorder` | none in top six | `approve_restock`, `cancel_restock`, `create_restock`, `create_return_label`, `list_return_label` |
| `o2-note-gift` | Add to 31877 that it's a birthday gift and shouldn't show the price on the slip | `create_order_note` | none in top six | `list_price`, `get_price`, `create_reorder_point`, `create_return_label`, `get_backorder` |
| `s2-hold-parcel` | Don't let the Berlin parcel for 31877 leave until the customer confirms she's home Thursday | `shipping_hold_shipment` | none in top six | `get_shipment`, `get_contact`, `get_account`, `get_address`, `get_customer_note` |
| `s2-rate-change` | The 48 hour option for Ireland goes up to 9.90 from Monday | `update_shipping_rate` | none in top six | `get_variant`, `delete_variant`, `find_sku`, `archive_variant`, `create_variant` |
| `s2-tracking-lookup` | The customer pasted 1Z7F2 into the chat, which order is that | `find_tracking_number` | none in top six | `get_shipment`, `get_contact`, `get_backorder`, `get_order_line`, `get_account` |
| `s2-delivery-slot` | Ravi can only take the delivery after six, push the slot back | `update_delivery` | none in top six | `get_delivery`, `get_bin`, `get_payment`, `get_shipping_fee`, `reopen_delivery` |
| `b2-hold-invoice` | Park INV-4410 until legal has looked at the wording | `hold_invoice` | none in top six | nothing |
| `b2-cycle-move` | Move Acme from monthly to quarterly invoicing starting January | `update_billing_cycle` | none in top six | `get_stock_transfer`, `approve_stock_transfer`, `create_reorder_point`, `create_stock_transfer`, `hold_stock_transfer` |
| `i2-remove-line` | Take the second row off INV-4410, the sample was free | `delete_invoice_line` | none in top six | `get_invoice_line`, `get_payout`, `get_credit_note`, `get_invoice`, `get_invoice_batch` |
| `i2-reopen` | INV-4410 was closed by mistake, open it back up so I can fix the PO number | `reopen_invoice` | none in top six | `get_tracking_number`, `find_tracking_number`, `get_payment`, `get_shipping_fee`, `find_order` |
| `p2-partial-back` | Give Ravi 12.50 of the 89.00 back, one item was missing from the box | `refund_payment` | none in top six | `get_product`, `get_order_line`, `export_product`, `get_payment`, `get_shipping_fee` |
| `p2-payout-schedule` | Pay the vendor for October on the 15th instead of the 30th | `schedule_payout` | none in top six | `get_payment`, `get_shipping_fee`, `refund_charge`, `refund_payment`, `refund_shipping_fee` |
| `p2-hold-payment` | Don't settle Ravi's 89.00 yet, fraud wants a look first | `hold_payment` | none in top six | `find_account`, `find_address`, `find_charge`, `find_customer`, `find_invoice` |
| `c2-merge-dupes` | Acme Ltd and ACME Limited are the same company, fold them into one record | `merge_customer` | none in top six | nothing |
| `c2-tag` | Mark everyone who bought the hoodie as a VIP | `create_customer_tag` | none in top six | nothing |
| `c2-release` | Acme paid what they owed, lift the freeze on their account | `release_customer` | none in top six | `get_user`, `accounts_hold_account`, `get_role`, `get_account`, `hold_account` |
| `c2-address-find` | Which of our customers are at 12 Harbour Street | `find_address` | none in top six | `get_contact`, `get_account`, `get_address`, `get_customer_note`, `list_contact` |
| `a2-new-user` | Get Priya's replacement set up with a login before Monday | `create_user` | none in top six | `accounts_get_account`, `find_account`, `merge_account`, `find_payment`, `find_sku` |
| `a2-sessions` | Where is Jonas logged in right now | `list_session` | none in top six | nothing |
| `v2-transfer-approve` | The 40 units heading to Cork can go, I've checked the paperwork | `approve_stock_transfer` | none in top six | nothing |
| `v2-reorder-new` | Start auto-reordering the hoodie at 30 units | `create_reorder_point` | none in top six | nothing |
| `v2-warehouse-find` | Which site holds the overflow stock for Ireland | `find_warehouse` | none in top six | `get_stock_count`, `get_stock_transfer`, `get_stock_level`, `get_warehouse`, `hold_stock_level` |
| `k2-price-approve` | The 39.90 for the hoodie is agreed, make it live | `approve_price` | none in top six | nothing |
| `k2-discount-schedule` | Turn the newsletter code on for Black Friday week only | `schedule_discount` | none in top six | `find_sku`, `get_sku`, `create_discount`, `list_discount` |
| `k2-product-hold` | Pull the hoodie from the shop until the recall is sorted | `hold_product` | none in top six | `export_statement`, `reports_export_invoice`, `export_account`, `export_chargeback`, `export_credit_note` |
| `k2-variant-new` | We're adding an XXL in the blue hoodie | `create_variant` | none in top six | nothing |
| `k2-category-merge` | Outerwear and Jackets are the same shelf online, combine them | `merge_category` | none in top six | `get_bin`, `get_category`, `get_contact`, `get_product`, `get_ticket` |
| `r2-exchange-new` | Ravi wants a medium instead of the large he got | `create_exchange` | none in top six | nothing |
| `r2-label` | Send Ravi something to stick on the box so he can post it back free | `create_return_label` | none in top six | `get_payment`, `get_shipping_fee`, `refund_charge`, `refund_payment`, `refund_shipping_fee` |
| `r2-refund-approve` | The hoodie came back clean, release Ravi's money | `returns_approve_refund` | none in top six | `get_payment`, `get_user`, `get_account`, `get_backorder`, `get_invoice` |
| `r2-restock-cancel` | Don't put the returned hoodie back on the shelf, it's damaged | `cancel_restock` | none in top six | `get_bin`, `get_payment`, `get_shipping_fee`, `assign_bin`, `list_bin` |
| `t2-escalate-assign` | Give the Acme escalation to Priya, she knows their account | `assign_escalation` | none in top six | `get_user`, `get_role`, `get_account`, `get_escalation`, `accounts_hold_account` |
| `t2-macro-archive` | Retire the old shipping-delay reply, we don't use it anymore | `archive_macro` | none in top six | `get_delivery`, `get_carrier`, `get_shipping_label`, `get_shipping_rate`, `shipping_cancel_shipment` |
| `t2-survey` | How did Ravi rate the last conversation | `get_satisfaction_survey` | none in top six | `get_ticket`, `get_shipping_rate`, `export_ticket`, `delete_ticket`, `list_ticket` |
| `t2-reply-edit` | I made a typo in my last reply to Ravi, fix the amount to 12.50 | `update_reply` | none in top six | `get_price`, `get_reply`, `approve_price`, `delete_reply`, `list_price` |
| `p2-inventory-schedule` | Every Monday morning I want the stock figures in my inbox | `schedule_inventory_report` | none in top six | `get_report`, `get_stock_count`, `get_stock_transfer`, `get_stock_level`, `release_stock_level` |
| `p2-report-hold` | Don't publish the Q3 numbers yet, the CFO hasn't signed them off | `hold_report` | none in top six | `get_payout`, `get_credit_note`, `get_invoice`, `get_invoice_batch`, `get_stock_count` |
| `p2-sales-list` | Which revenue breakdowns did we run this quarter | `list_sales_report` | none in top six | `get_invoice_batch`, `get_sales_report`, `approve_invoice_batch`, `cancel_invoice_batch`, `create_invoice_batch` |

### Custom scorer (hierarchical, external)

35 of 55 tasks did not route their expected capability into the set of 5 the runtime would publish.

| Task | Prompt | Expected | Rank | Routed instead |
| --- | --- | --- | --- | --- |
| `o2-stop-order` | Ravi rang, he ordered the wrong size on 31877, kill the whole thing before it gets picked | `cancel_order` | none in top six | `get_variant`, `get_category`, `get_discount`, `get_price`, `get_product` |
| `o2-merge-double` | Same customer placed 31877 and 31878 within a minute for the same address, make them one | `merge_order` | none in top six | `get_address`, `create_address`, `delete_address`, `find_address`, `get_customer_note` |
| `o2-backorder-release` | The restock for the blue hoodie landed, let the people waiting on it have theirs now | `release_backorder` | none in top six | `approve_restock`, `cancel_restock`, `create_restock`, `release_return` |
| `o2-note-gift` | Add to 31877 that it's a birthday gift and shouldn't show the price on the slip | `create_order_note` | none in top six | `list_price`, `approve_price`, `get_price`, `update_price`, `create_discount` |
| `s2-hold-parcel` | Don't let the Berlin parcel for 31877 leave until the customer confirms she's home Thursday | `shipping_hold_shipment` | none in top six | `release_shipment`, `shipping_release_shipment`, `assign_shipment`, `cancel_shipment`, `create_shipment` |
| `s2-rate-change` | The 48 hour option for Ireland goes up to 9.90 from Monday | `update_shipping_rate` | none in top six | `archive_variant`, `create_variant`, `delete_variant`, `find_sku`, `get_variant` |
| `s2-tracking-lookup` | The customer pasted 1Z7F2 into the chat, which order is that | `find_tracking_number` | none in top six | `get_customer`, `support_create_order_note`, `support_find_customer`, `support_list_customer`, `support_list_order_note` |
| `s2-delivery-slot` | Ravi can only take the delivery after six, push the slot back | `update_delivery` | none in top six | `refund_charge`, `refund_payment`, `refund_shipping_fee`, `approve_chargeback`, `approve_credit_note` |
| `b2-hold-invoice` | Park INV-4410 until legal has looked at the wording | `hold_invoice` | none in top six | nothing |
| `b2-cycle-move` | Move Acme from monthly to quarterly invoicing starting January | `update_billing_cycle` | none in top six | `hold_stock_transfer`, `approve_stock_transfer`, `create_stock_transfer`, `get_stock_transfer`, `list_stock_transfer` |
| `i2-remove-line` | Take the second row off INV-4410, the sample was free | `delete_invoice_line` | none in top six | `approve_invoice_batch`, `approve_payment_terms`, `invoices_approve_invoice`, `cancel_invoice_batch`, `cancel_reminder` |
| `i2-reopen` | INV-4410 was closed by mistake, open it back up so I can fix the PO number | `reopen_invoice` | none in top six | `find_charge`, `find_invoice`, `find_payment`, `get_charge`, `get_chargeback` |
| `p2-payout-schedule` | Pay the vendor for October on the 15th instead of the 30th | `schedule_payout` | none in top six | `refund_charge`, `refund_payment`, `refund_shipping_fee` |
| `p2-hold-payment` | Don't settle Ravi's 89.00 yet, fraud wants a look first | `hold_payment` | none in top six | `find_account`, `find_invoice`, `find_session`, `find_user`, `list_api_key` |
| `c2-merge-dupes` | Acme Ltd and ACME Limited are the same company, fold them into one record | `merge_customer` | none in top six | nothing |
| `c2-tag` | Mark everyone who bought the hoodie as a VIP | `create_customer_tag` | none in top six | nothing |
| `c2-release` | Acme paid what they owed, lift the freeze on their account | `release_customer` | none in top six | `accounts_hold_account`, `hold_account`, `accounts_get_account`, `accounts_release_account`, `accounts_update_account` |
| `c2-address-find` | Which of our customers are at 12 Harbour Street | `find_address` | none in top six | `archive_customer`, `create_customer`, `create_customer_tag`, `delete_customer`, `delete_customer_note` |
| `a2-new-user` | Get Priya's replacement set up with a login before Monday | `create_user` | none in top six | `accounts_get_account`, `find_account`, `get_return_label`, `get_role`, `get_user` |
| `a2-sessions` | Where is Jonas logged in right now | `list_session` | none in top six | nothing |
| `v2-transfer-approve` | The 40 units heading to Cork can go, I've checked the paperwork | `approve_stock_transfer` | none in top six | nothing |
| `v2-warehouse-find` | Which site holds the overflow stock for Ireland | `find_warehouse` | none in top six | `hold_stock_level`, `hold_stock_transfer`, `release_stock_level`, `release_stock_transfer`, `approve_stock_count` |
| `k2-price-approve` | The 39.90 for the hoodie is agreed, make it live | `approve_price` | none in top six | nothing |
| `k2-discount-schedule` | Turn the newsletter code on for Black Friday week only | `schedule_discount` | none in top six | `find_sku`, `get_sku` |
| `k2-product-hold` | Pull the hoodie from the shop until the recall is sorted | `hold_product` | none in top six | `export_account`, `export_credit_note`, `export_invoice`, `export_statement` |
| `k2-variant-new` | We're adding an XXL in the blue hoodie | `create_variant` | none in top six | nothing |
| `k2-category-merge` | Outerwear and Jackets are the same shelf online, combine them | `merge_category` | none in top six | `assign_bin`, `get_bin`, `list_bin`, `merge_account`, `update_bin` |
| `r2-exchange-new` | Ravi wants a medium instead of the large he got | `create_exchange` | none in top six | nothing |
| `r2-label` | Send Ravi something to stick on the box so he can post it back free | `create_return_label` | none in top six | `refund_charge`, `refund_payment`, `refund_shipping_fee`, `approve_chargeback`, `approve_credit_note` |
| `r2-refund-approve` | The hoodie came back clean, release Ravi's money | `returns_approve_refund` | none in top six | `release_invoice`, `release_payment`, `refund_charge`, `refund_payment`, `refund_shipping_fee` |
| `r2-restock-cancel` | Don't put the returned hoodie back on the shelf, it's damaged | `cancel_restock` | none in top six | `refund_charge`, `refund_payment`, `refund_shipping_fee`, `hold_invoice`, `hold_payment` |
| `t2-survey` | How did Ravi rate the last conversation | `get_satisfaction_survey` | none in top six | `archive_shipping_rate`, `delete_shipping_rate`, `get_shipping_rate`, `list_shipping_rate`, `update_shipping_rate` |
| `p2-inventory-schedule` | Every Monday morning I want the stock figures in my inbox | `schedule_inventory_report` | none in top six | `get_report`, `approve_report`, `archive_report`, `create_inventory_report`, `create_report` |
| `p2-report-hold` | Don't publish the Q3 numbers yet, the CFO hasn't signed them off | `hold_report` | none in top six | `create_tracking_number`, `find_tracking_number`, `get_tracking_number`, `approve_credit_note`, `approve_invoice` |
| `p2-sales-list` | Which revenue breakdowns did we run this quarter | `list_sales_report` | none in top six | `approve_invoice_batch`, `cancel_invoice_batch`, `create_invoice_batch`, `create_sales_report`, `export_invoice_batch` |

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
