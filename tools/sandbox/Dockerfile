FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends nodejs php-cli && rm -rf /var/lib/apt/lists/*
COPY runner.py /opt/workspace-runner.py
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["python3", "-I", "/opt/workspace-runner.py"]
