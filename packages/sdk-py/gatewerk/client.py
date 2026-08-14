"""Sync client factory for the Gatewerk Python SDK."""

from __future__ import annotations

import os
from typing import Optional, Union

import httpx

from ._base import BaseResource, DEFAULT_MAX_RETRIES
from ._version import __version__
from .resources.reviews import ReviewsResource
from .resources.feedback import FeedbackResource
from .resources.templates import TemplatesResource
from .resources.webhooks import WebhooksResource
from .resources.audit import AuditResource
from .resources.stats import StatsResource
from .resources.chains import ChainsResource
from .resources.notes import NotesResource
from .types import KeyInfo


class GatewerkClient:
    """Resource-based client for the Gatewerk API.

    Thread safety: The sync client is thread-safe (httpx.Client uses
    connection pooling with locks). However, ``resource.last_response``
    is NOT thread-safe — read it immediately after the call.

    Usage::

        with create_client(api_key="gw_key_...") as gw:
            review = gw.reviews.create(...)
    """

    def __init__(
        self,
        api_key: str,
        url: str,
        *,
        max_retries: int = DEFAULT_MAX_RETRIES,
        timeout: float = 30.0,
        http_client: Optional[httpx.Client] = None,
        proxy: Optional[str] = None,
        verify_ssl: bool = True,
    ) -> None:
        if http_client is not None:
            self._http = http_client
            self._owns_http = False
        else:
            client_kwargs: dict = {
                "base_url": url.rstrip("/"),
                "headers": {
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "X-Gatewerk-Origin": "py-sdk",
                    "X-Gatewerk-Version": __version__,
                },
                "timeout": timeout,
            }
            if proxy is not None:
                client_kwargs["proxy"] = proxy
            if not verify_ssl:
                client_kwargs["verify"] = False
            self._http = httpx.Client(**client_kwargs)
            self._owns_http = True

        self._base = BaseResource(self._http, max_retries)
        self.reviews = ReviewsResource(self._http, max_retries)
        self.feedback = FeedbackResource(self._http, max_retries)
        self.templates = TemplatesResource(self._http, max_retries)
        self.webhooks = WebhooksResource(self._http, max_retries)
        self.audit = AuditResource(self._http, max_retries)
        self.stats = StatsResource(self._http, max_retries)
        self.chains = ChainsResource(self._http, max_retries)
        self.notes = NotesResource(self._http, max_retries)

    def key_info(self, *, timeout: Optional[float] = None) -> KeyInfo:
        """Introspect the current API key's scopes and metadata."""
        data = self._base._request("GET", "/api/v1/auth/key-info", timeout=timeout)
        return KeyInfo.model_validate(data)

    def close(self) -> None:
        """Close the underlying HTTP connection pool (if owned by this client)."""
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> GatewerkClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def create_client(
    api_key: Optional[str] = None,
    url: Optional[str] = None,
    *,
    max_retries: int = DEFAULT_MAX_RETRIES,
    timeout: float = 30.0,
    http_client: Optional[httpx.Client] = None,
    proxy: Optional[str] = None,
    verify_ssl: bool = True,
) -> GatewerkClient:
    """Create a Gatewerk client.

    Args:
        api_key: API key. Falls back to GATEWERK_API_KEY env var.
        url: API URL. Falls back to GATEWERK_URL env var, then http://localhost:3100.
        max_retries: Max retries on 429/5xx errors (default 2). Set 0 to disable.
        timeout: Default request timeout in seconds (default 30).
        http_client: Custom httpx.Client (for proxies, custom TLS, etc.).
            If provided, you are responsible for configuring base_url and auth headers.
        proxy: Proxy URL (e.g. "http://proxy:8080"). Ignored if http_client is set.
        verify_ssl: Verify TLS certificates (default True). Ignored if http_client is set.
    """
    resolved_key = api_key or os.environ.get("GATEWERK_API_KEY")
    resolved_url = url or os.environ.get("GATEWERK_URL", "http://localhost:3100")

    if not resolved_key:
        raise ValueError(
            "API key is required. Pass api_key or set GATEWERK_API_KEY env var."
        )

    return GatewerkClient(
        api_key=resolved_key,
        url=resolved_url,
        max_retries=max_retries,
        timeout=timeout,
        http_client=http_client,
        proxy=proxy,
        verify_ssl=verify_ssl,
    )
