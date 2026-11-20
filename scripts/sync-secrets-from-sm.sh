#!/usr/bin/env bash
# Pull Razorpay + WhatsApp secrets from GCP Secret Manager into local .env.
# Does NOT flip MOCK_* (keeps local simulator / mock-confirm usable).
# Compatible with macOS /bin/bash 3.2 (no associative arrays).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy from .env.example first" >&2
  exit 1
fi

need=(
  WHATSAPP_VERIFY_TOKEN
  WHATSAPP_APP_SECRET
  WHATSAPP_ACCESS_TOKEN
  WHATSAPP_PHONE_NUMBER_ID
  RAZORPAY_KEY_ID
  RAZORPAY_KEY_SECRET
  RAZORPAY_WEBHOOK_SECRET
)

for s in "${need[@]}"; do
  val="$(gcloud secrets versions access latest --secret="$s")"
  if [[ -z "$val" || "$val" == "REPLACE_ME" ]]; then
    echo "BAD secret: $s (empty or REPLACE_ME)" >&2
    exit 1
  fi
  echo "OK  $s (len=${#val})"
  export "SYNC_${s}=${val}"
done

export SYNC_ENV_FILE="$ENV_FILE"

python3 <<'PY'
import os, re, pathlib
path = pathlib.Path(os.environ["SYNC_ENV_FILE"])
text = path.read_text()
updates = {
    "WHATSAPP_VERIFY_TOKEN": os.environ["SYNC_WHATSAPP_VERIFY_TOKEN"],
    "WHATSAPP_APP_SECRET": os.environ["SYNC_WHATSAPP_APP_SECRET"],
    "WHATSAPP_ACCESS_TOKEN": os.environ["SYNC_WHATSAPP_ACCESS_TOKEN"],
    "WHATSAPP_PHONE_NUMBER_ID": os.environ["SYNC_WHATSAPP_PHONE_NUMBER_ID"],
    "WHATSAPP_API_VERSION": "v21.0",
    "RAZORPAY_KEY_ID": os.environ["SYNC_RAZORPAY_KEY_ID"],
    "RAZORPAY_KEY_SECRET": os.environ["SYNC_RAZORPAY_KEY_SECRET"],
    "RAZORPAY_WEBHOOK_SECRET": os.environ["SYNC_RAZORPAY_WEBHOOK_SECRET"],
}
for k, v in updates.items():
    pattern = re.compile(rf"^{re.escape(k)}=.*$", re.M)
    line = f"{k}={v}"
    if pattern.search(text):
        text = pattern.sub(line, text)
    else:
        text = text.rstrip() + "\n" + line + "\n"
path.write_text(text)
print(f"Updated {path} (MOCK_* unchanged)")
PY
