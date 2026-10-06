"""OpsBot CT102 層。

本番への反映は GitHub の deploy ブランチから自動で行う（ct/deploy/opsbot-ct-deploy.sh・
README「自動デプロイ」）。/opt/opsbot/ct を手作業で書き換えないこと。
"""

__all__ = ["config", "poller"]
