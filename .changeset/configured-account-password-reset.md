---
"@_linked/auth": patch
---

Use the account shape configured by `AUTH_ACCOUNT_TYPE` throughout password recovery. Applications whose accounts use a custom RDF target class can now request and redeem password-reset links, and reset-email input is trimmed before normalization.
