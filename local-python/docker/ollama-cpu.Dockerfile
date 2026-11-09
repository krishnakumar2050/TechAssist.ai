# Reuse the current official Ollama binaries on the same AlmaLinux 8 baseline
# used by its upstream build. This avoids newer libc clone3 behavior on Docker 20.
FROM ollama/ollama:latest AS upstream
FROM almalinux:8
RUN dnf install -y ca-certificates libgomp libstdc++ openssl-libs && dnf clean all
COPY --from=upstream /usr/bin/ollama /usr/bin/ollama
COPY --from=upstream /usr/lib/ollama/*.so* /usr/lib/ollama/
COPY --from=upstream /usr/lib/ollama/llama-server /usr/lib/ollama/llama-server
COPY --from=upstream /usr/lib/ollama/*LICENSE* /usr/lib/ollama/
COPY --from=upstream /usr/lib/ollama/*NOTICE* /usr/lib/ollama/
ENV OLLAMA_HOST=0.0.0.0:11434
ENV OLLAMA_NUM_PARALLEL=1
ENV OLLAMA_MAX_LOADED_MODELS=1
EXPOSE 11434
ENTRYPOINT ["/usr/bin/ollama"]
CMD ["serve"]
