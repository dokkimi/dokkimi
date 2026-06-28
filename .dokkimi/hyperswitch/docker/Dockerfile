FROM docker.juspay.io/juspaydotin/hyperswitch-router:latest
COPY docker_compose.toml /local/config/docker_compose.toml
COPY --chmod=755 entrypoint.sh /entrypoint.sh
CMD ["/bin/bash", "/entrypoint.sh"]
