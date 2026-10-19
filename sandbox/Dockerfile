FROM oven/bun:1.4.2 AS bun
FROM python:3.13-slim

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends jq ripgrep \
  && rm -rf /var/lib/apt/lists/*

COPY runner.py /runner/runner.py
RUN chmod 755 /runner/runner.py

USER 65534:65534
WORKDIR /workspace
ENTRYPOINT ["python3", "-u", "/runner/runner.py"]
