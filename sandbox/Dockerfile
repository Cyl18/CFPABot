FROM oven/bun:1

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 jq ripgrep \
  && rm -rf /var/lib/apt/lists/*

COPY runner.py /runner/runner.py
RUN chmod 755 /runner/runner.py

USER 65534:65534
WORKDIR /workspace
ENTRYPOINT ["python3", "-u", "/runner/runner.py"]
