# Docker Best Practices

## Multi-stage Builds
- Use multi-stage builds to minimize image size
- Separate build dependencies from runtime dependencies
- Copy only necessary artifacts to the final stage

## Layer Caching
- Order Dockerfile instructions from least to most frequently changing
- Group related RUN commands to reduce layers
- Use .dockerignore to exclude unnecessary files

## Security
- Run containers as non-root user
- Scan images for vulnerabilities
- Pin base image versions with SHA digests
- Never store secrets in images or environment variables

## Compose Patterns
- Use named volumes for persistent data
- Define health checks for all services
- Use depends_on with condition: service_healthy
