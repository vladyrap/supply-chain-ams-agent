#!/bin/sh
# =============================================================================
# entrypoint.sh — Alertmanager con envsubst (v1.1.2-hotfix)
# =============================================================================
# FIX A21 (audit v1.1.0): Alertmanager NO interpola env vars en YAML.
# Sin esto, el literal "${SLACK_WEBHOOK_URL}" iba a Slack y todas las alertas
# fallaban silenciosamente.
#
# Este entrypoint:
#   1. Toma /etc/alertmanager/alertmanager.tmpl como template
#   2. Sustituye ${SLACK_WEBHOOK_URL}, ${PAGERDUTY_KEY}, etc con envsubst
#   3. Escribe el resultado a /tmp/alertmanager.yml
#   4. Lanza alertmanager apuntando al archivo procesado
# =============================================================================

set -eu

TMPL="${ALERTMANAGER_TMPL:-/etc/alertmanager/alertmanager.tmpl}"
OUT="${ALERTMANAGER_CONFIG_FILE:-/tmp/alertmanager.yml}"

if [ ! -f "$TMPL" ]; then
  echo "FATAL: template no encontrado en $TMPL"
  exit 1
fi

# Lista explícita de vars que interpolamos (no expone otras vars al config).
export SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"
export PAGERDUTY_KEY="${PAGERDUTY_KEY:-}"
export ALERTMANAGER_SMTP_HOST="${ALERTMANAGER_SMTP_HOST:-}"
export ALERTMANAGER_SMTP_FROM="${ALERTMANAGER_SMTP_FROM:-}"
export ALERTMANAGER_SMTP_USERNAME="${ALERTMANAGER_SMTP_USERNAME:-}"
export ALERTMANAGER_SMTP_PASSWORD="${ALERTMANAGER_SMTP_PASSWORD:-}"
export ALERTMANAGER_TO="${ALERTMANAGER_TO:-alerts@example.com}"

envsubst '${SLACK_WEBHOOK_URL} ${PAGERDUTY_KEY} ${ALERTMANAGER_SMTP_HOST} ${ALERTMANAGER_SMTP_FROM} ${ALERTMANAGER_SMTP_USERNAME} ${ALERTMANAGER_SMTP_PASSWORD} ${ALERTMANAGER_TO}' < "$TMPL" > "$OUT"

echo "==> alertmanager.yml generado en $OUT"

# Reemplazar config.file con el resultado del template, conservando otros args.
exec /bin/alertmanager --config.file="$OUT" "$@"
