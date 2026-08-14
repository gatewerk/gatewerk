"""Shared HTTP request logic for sync and async resource classes."""

from __future__ import annotations

import asyncio
import logging
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from .errors import (
    GatewerkError,
    InvalidRequestError,
    AuthenticationError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    RateLimitError,
)

logger = logging.getLogger("gatewerk")

_ERROR_MAP = {
    400: InvalidRequestError,
    401: AuthenticationError,
    403: ForbiddenError,
    404: NotFoundError,
    409: ConflictError,
    429: RateLimitError,
}

RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}
DEFAULT_MAX_RETRIES = 2
DEFAULT_INITIAL_BACKOFF = 0.5
DEFAULT_MAX_BACKOFF = 30.0


# ---------------------------------------------------------------------------
# Response metadata
# ---------------------------------------------------------------------------


@dataclass
class ResponseInfo:
    """Metadata from the last API response. Access via resource.last_response."""

    status_code: int
    request_id: str
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def rate_limit_remaining(self) -> Optional[int]:
        val = self.headers.get("x-ratelimit-remaining")
        return int(val) if val else None

    @property
    def rate_limit_reset(self) -> Optional[str]:
        return self.headers.get("x-ratelimit-reset")

    @property
    def server_request_id(self) -> Optional[str]:
        return self.headers.get("x-request-id")


# ---------------------------------------------------------------------------
# Error helpers
# ---------------------------------------------------------------------------


def _parse_retry_after(resp: httpx.Response) -> Optional[float]:
    """Extract Retry-After header value in seconds."""
    value = resp.headers.get("retry-after")
    if value:
        try:
            return float(value)
        except ValueError:
            pass
    return None


def _calculate_backoff(
    attempt: int,
    base: float = DEFAULT_INITIAL_BACKOFF,
    max_delay: float = DEFAULT_MAX_BACKOFF,
) -> float:
    """Exponential backoff with jitter."""
    delay = min(base * (2 ** attempt), max_delay)
    jitter = random.uniform(0, delay * 0.25)
    return delay + jitter


def _raise_for_error(
    resp: httpx.Response,
    request_id: Optional[str] = None,
) -> None:
    """Parse API error response and raise the appropriate typed exception."""
    raw_body = resp.text
    try:
        body = resp.json()
        err = body.get("error", {})
        message = err.get("message", raw_body)
        code = err.get("code", "unknown")
        param = err.get("param")
    except (ValueError, KeyError, TypeError, AttributeError):
        message = raw_body
        code = "unknown"
        param = None

    error_cls = _ERROR_MAP.get(resp.status_code, GatewerkError)

    if error_cls is InvalidRequestError:
        exc = error_cls(message, param=param, code=code)
    elif error_cls in (NotFoundError, ConflictError):
        exc = error_cls(message, code=code)
    elif error_cls is RateLimitError:
        exc = error_cls(message)
        exc.retry_after = _parse_retry_after(resp)
    else:
        exc = error_cls(message)

    exc.request_id = request_id
    exc.raw_body = raw_body
    raise exc


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------


class BaseResource:
    """Base class for sync API resources with retry, logging, and error handling.

    Thread safety: The sync client uses httpx.Client which is thread-safe.
    However, ``last_response`` is set per-call and is NOT thread-safe —
    in multi-threaded code, read it immediately after the call.
    """

    def __init__(
        self,
        http: httpx.Client,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        self._http = http
        self._max_retries = max_retries
        self.last_response: Optional[ResponseInfo] = None

    def _request(
        self,
        method: str,
        path: str,
        *,
        timeout: Optional[float] = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        request_id = str(uuid.uuid4())
        last_error: Optional[Exception] = None

        for attempt in range(self._max_retries + 1):
            try:
                logger.debug(
                    "Request %s: %s %s (attempt %d)",
                    request_id, method, path, attempt + 1,
                )

                request_kwargs: dict[str, Any] = dict(kwargs)
                if timeout is not None:
                    request_kwargs["timeout"] = timeout

                resp = self._http.request(method, path, **request_kwargs)

                logger.debug(
                    "Response %s: %s %s -> %d",
                    request_id, method, path, resp.status_code,
                )

                if resp.is_success:
                    self.last_response = ResponseInfo(
                        status_code=resp.status_code,
                        request_id=request_id,
                        headers=dict(resp.headers),
                    )
                    if resp.status_code == 204 or not resp.content:
                        return {}
                    return resp.json()

                # Retry on transient errors
                if resp.status_code in RETRYABLE_STATUS_CODES and attempt < self._max_retries:
                    delay = _parse_retry_after(resp) or _calculate_backoff(attempt)
                    logger.info(
                        "Retrying %s %s %s (status %d, attempt %d/%d, delay %.1fs)",
                        request_id, method, path, resp.status_code,
                        attempt + 1, self._max_retries, delay,
                    )
                    time.sleep(delay)
                    continue

                _raise_for_error(resp, request_id=request_id)

            except (httpx.TimeoutException, httpx.ConnectError) as exc:
                last_error = exc
                if attempt < self._max_retries:
                    delay = _calculate_backoff(attempt)
                    logger.info(
                        "Network error %s on %s %s (%s), retrying (attempt %d/%d)",
                        request_id, method, path, type(exc).__name__,
                        attempt + 1, self._max_retries,
                    )
                    time.sleep(delay)
                    continue
                err = GatewerkError(
                    f"Request failed after {self._max_retries + 1} attempts: {exc}"
                )
                err.request_id = request_id
                raise err from exc

        raise GatewerkError("Request failed") from last_error


# ---------------------------------------------------------------------------
# Async
# ---------------------------------------------------------------------------


class AsyncBaseResource:
    """Base class for async API resources with retry, logging, and error handling.

    Thread safety: AsyncGatewerkClient must NOT be shared across threads.
    It is designed for a single asyncio event loop.
    """

    def __init__(
        self,
        http: httpx.AsyncClient,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        self._http = http
        self._max_retries = max_retries
        self.last_response: Optional[ResponseInfo] = None

    async def _request(
        self,
        method: str,
        path: str,
        *,
        timeout: Optional[float] = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        request_id = str(uuid.uuid4())
        last_error: Optional[Exception] = None

        for attempt in range(self._max_retries + 1):
            try:
                logger.debug(
                    "Async request %s: %s %s (attempt %d)",
                    request_id, method, path, attempt + 1,
                )

                request_kwargs: dict[str, Any] = dict(kwargs)
                if timeout is not None:
                    request_kwargs["timeout"] = timeout

                resp = await self._http.request(method, path, **request_kwargs)

                logger.debug(
                    "Async response %s: %s %s -> %d",
                    request_id, method, path, resp.status_code,
                )

                if resp.is_success:
                    self.last_response = ResponseInfo(
                        status_code=resp.status_code,
                        request_id=request_id,
                        headers=dict(resp.headers),
                    )
                    if resp.status_code == 204 or not resp.content:
                        return {}
                    return resp.json()

                if resp.status_code in RETRYABLE_STATUS_CODES and attempt < self._max_retries:
                    delay = _parse_retry_after(resp) or _calculate_backoff(attempt)
                    logger.info(
                        "Retrying async %s %s %s (status %d, attempt %d/%d, delay %.1fs)",
                        request_id, method, path, resp.status_code,
                        attempt + 1, self._max_retries, delay,
                    )
                    await asyncio.sleep(delay)
                    continue

                _raise_for_error(resp, request_id=request_id)

            except (httpx.TimeoutException, httpx.ConnectError) as exc:
                last_error = exc
                if attempt < self._max_retries:
                    delay = _calculate_backoff(attempt)
                    logger.info(
                        "Network error %s on async %s %s (%s), retrying (attempt %d/%d)",
                        request_id, method, path, type(exc).__name__,
                        attempt + 1, self._max_retries,
                    )
                    await asyncio.sleep(delay)
                    continue
                err = GatewerkError(
                    f"Request failed after {self._max_retries + 1} attempts: {exc}"
                )
                err.request_id = request_id
                raise err from exc

        raise GatewerkError("Request failed") from last_error
