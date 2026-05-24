# remotedesk_jazverse

RemoteDesk Jazverse is a consent-based remote desktop web interface prototype.

This repository currently contains the hosted web UI for `remotedesk.jazverse.online`.
The UI is designed around explicit approval from the computer being controlled,
one-time session codes, visible permission toggles, a revoke button, and audit logs.

## Deployment

The GitHub Actions workflow deploys static files to the Jazverse Cloud VM over SSH.
Configure these repository secrets before relying on automatic deploys:

- `REMOTEDESK_SSH_HOST`
- `REMOTEDESK_SSH_USER`
- `REMOTEDESK_SSH_KEY`
- `REMOTEDESK_DEPLOY_PATH`

Recommended deploy path:

```text
/var/www/remotedesk.jazverse.online
```
