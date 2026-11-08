#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== CheckFlow ET Services Startup ==="

# 1. Clean stale postgres locks if postgres is not running
if ! pgrep -f "postgres -D /tmp/pg_data" > /dev/null 2>&1; then
  echo "[Postgres] Cleaning stale locks..."
  rm -f /tmp/pg_data/postmaster.pid /tmp/.s.PGSQL.5432 /tmp/.s.PGSQL.5432.lock
  echo "[Postgres] Starting database..."
  /usr/lib/postgresql/16/bin/postgres -D /tmp/pg_data -k /tmp -c listen_addresses='' > /tmp/postgres.log 2>&1 &
  sleep 2
fi

# 2. Verify Postgres connection
echo "[Postgres] Verifying database connectivity..."
for i in {1..10}; do
  if psql -h /tmp -U postgres -d checkflow -c "SELECT 1;" > /dev/null 2>&1; then
    echo "[Postgres] Database is ready!"
    break
  fi
  sleep 1
done

# 3. Start Backend server
echo "[Backend] Starting Node/Express server..."
node dist/index.js
