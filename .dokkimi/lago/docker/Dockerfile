FROM getlago/api:v1.48.1

# Generate a test RSA key at build time
RUN mkdir -p /app/config/keys && \
    ruby -e "require 'openssl'; File.write('/app/config/keys/private.pem', OpenSSL::PKey::RSA.generate(2048).to_pem)"

# Fix dev-only gem that crashes in production
RUN sed -i 's/require "annotate_rb"/require "annotate_rb" rescue nil/' /app/lib/tasks/annotate_rb.rake 2>/dev/null || true

COPY entrypoint.sh /app/scripts/dokkimi-entrypoint.sh
RUN chmod +x /app/scripts/dokkimi-entrypoint.sh

ENTRYPOINT ["/app/scripts/dokkimi-entrypoint.sh"]
