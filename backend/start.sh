#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== CheckFlow ET Services Startup ==="

# 1. Clean stale postgres locks or init if missing
if [ ! -d "/tmp/pg_data" ]; then
  echo "[Postgres] Initializing new database cluster at /tmp/pg_data..."
  /usr/lib/postgresql/16/bin/initdb -D /tmp/pg_data -U postgres > /dev/null 2>&1
fi

if ! pgrep -f "postgres -D /tmp/pg_data" > /dev/null 2>&1; then
  echo "[Postgres] Cleaning stale locks..."
  rm -f /tmp/pg_data/postmaster.pid /tmp/.s.PGSQL.5432 /tmp/.s.PGSQL.5432.lock
  echo "[Postgres] Starting database..."
  /usr/lib/postgresql/16/bin/postgres -D /tmp/pg_data -k /tmp -c listen_addresses='' > /tmp/postgres.log 2>&1 &
  sleep 2
fi

# 2. Verify Postgres connection & ensure database exists
echo "[Postgres] Verifying database connectivity..."
for i in {1..10}; do
  if psql -h /tmp -U postgres -d postgres -c "SELECT 1;" > /dev/null 2>&1; then
    echo "[Postgres] Server is ready!"
    break
  fi
  sleep 1
done

if ! psql -h /tmp -U postgres -lqt | cut -d \| -f 1 | grep -qw checkflow; then
  echo "[Postgres] Creating checkflow database..."
  createdb -h /tmp -U postgres checkflow
  npx prisma migrate deploy
fi

# 3. Start Backend server
echo "[Backend] Starting Node/Express server..."
node dist/index.js
