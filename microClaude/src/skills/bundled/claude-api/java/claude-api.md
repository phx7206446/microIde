# Java Claude API

Use the Java SDK for JVM services, Spring applications, and enterprise backends.

Guidance:
- Centralize client construction and credentials loading.
- Model request and response objects explicitly.
- Use streaming only when the UI or downstream transport can consume partial output.
- Put retries around transport failures, not around obviously invalid requests.
