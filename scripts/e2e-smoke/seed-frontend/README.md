# auto-finish-fe-smoke

Frontend half of the auto-finish two-repo smoke. Pairs with
[`auto-finish-be-smoke`](https://github.com/wxpftd/auto-finish-be-smoke).

Has an `<input id="msg">` + `<button id="send">` + `<pre id="result">`. Currently
un-wired.

Pending (added by an auto-finish run): hook the button to the backend's
`/api/echo?msg=...` endpoint and render the `echoed` field into `#result`.
