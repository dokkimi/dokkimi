#!/bin/bash

echo "Generating RSA key..."
mkdir -p /app/config/keys
ruby -e "require 'openssl'; File.write('/app/config/keys/private.pem', OpenSSL::PKey::RSA.generate(2048).to_pem)"

echo "Patching dev-only gem..."
sed -i 's/require "annotate_rb"/require "annotate_rb" rescue nil/' /app/lib/tasks/annotate_rb.rake 2>/dev/null || true

echo "Waiting for PostgreSQL..."
until pg_isready -h lago-postgres -p 5432 -q 2>/dev/null; do
  sleep 2
done
echo "PostgreSQL is ready."

echo "Waiting for Redis..."
until bash -c "echo > /dev/tcp/lago-redis/6379" 2>/dev/null; do
  sleep 2
done
echo "Redis is ready."

echo "Running migrations..."
bundle exec rails db:migrate 2>&1

echo "Seeding organization..."
bundle exec rails runner '
  user = User.create_with(password: "P@ssword123!").find_or_create_by!(email: "test@dokkimi.com")

  org = Organization.find_or_create_by!(name: "Dokkimi Test Org") do |o|
    o.hmac_key = SecureRandom.hex(32) if o.respond_to?(:hmac_key=)
  end

  BillingEntity.find_or_create_by!(organization: org, code: "dokkimi-test-org") do |be|
    be.name = "Dokkimi Test Org"
    be.id = org.id
  end

  admin_role = Role.find_or_create_by!(admin: true) do |r|
    r.code = "admin"
    r.name = "Admin"
  end

  membership = Membership.find_or_create_by!(user: user, organization: org)
  MembershipRole.find_or_create_by!(membership: membership, organization: org, role: admin_role)

  api_key = ApiKey.find_or_create_by!(organization: org) do |k|
    k.value = SecureRandom.uuid
  end
  api_key.update_column(:value, "dokkimi-test-api-key-lago-123")
  puts "Seeded org=#{org.id} api_key=#{api_key.reload.value}"
' 2>&1

echo "Starting Sidekiq worker..."
bundle exec sidekiq -q default -q webhook -q invoices -q events -q providers -q clock -q integrations &

echo "Starting server..."
exec bundle exec rails server -b 0.0.0.0 -p 3000
