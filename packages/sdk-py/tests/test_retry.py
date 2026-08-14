"""Tests for retry logic with exponential backoff (sync and async)."""

from __future__ import annotations

from unittest.mock import patch

import httpx
import pytest

from gatewerk import GatewerkError, RateLimitError, Review


# ---------------------------------------------------------------------------
# Sync helpers
# ---------------------------------------------------------------------------


def _make_reviews_resource(handler, max_retries=2):
    from gatewerk.resources.reviews import ReviewsResource

    transport = httpx.MockTransport(handler)
    http = httpx.Client(
        transport=transport,
        base_url="http://test:3100",
        headers={"Authorization": "Bearer gw_key_test", "Content-Type": "application/json"},
    )
    return ReviewsResource(http, max_retries=max_retries)


def _make_async_reviews_resource(handler, max_retries=2):
    from gatewerk.async_client import AsyncReviewsResource

    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(
        transport=transport,
        base_url="http://test:3100",
        headers={"Authorization": "Bearer gw_key_test", "Content-Type": "application/json"},
    )
    return AsyncReviewsResource(http, max_retries=max_retries)


# ---------------------------------------------------------------------------
# Sync retry tests
# ---------------------------------------------------------------------------


class TestRetryOnServerError:
    @patch("gatewerk._base.time.sleep")
    def test_retries_on_500_then_succeeds(self, mock_sleep):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                return httpx.Response(500, json={"error": {"message": "Server error"}})
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "pending"})

        resource = _make_reviews_resource(handler, max_retries=2)
        result = resource.get("gw_rev_001")

        assert isinstance(result, Review)
        assert attempts == 3
        assert mock_sleep.call_count == 2

    @patch("gatewerk._base.time.sleep")
    def test_exhausts_retries_then_raises(self, mock_sleep):
        def handler(request: httpx.Request):
            return httpx.Response(500, json={"error": {"message": "Server error"}})

        resource = _make_reviews_resource(handler, max_retries=2)
        with pytest.raises(GatewerkError, match="Server error"):
            resource.get("gw_rev_001")
        assert mock_sleep.call_count == 2

    @patch("gatewerk._base.time.sleep")
    def test_retries_on_502(self, mock_sleep):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(502, text="Bad Gateway")
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review"})

        resource = _make_reviews_resource(handler, max_retries=1)
        result = resource.get("gw_rev_001")
        assert result.id == "gw_rev_001"

    @patch("gatewerk._base.time.sleep")
    def test_retries_on_503(self, mock_sleep):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(503, json={"error": {"message": "Service unavailable"}})
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review"})

        resource = _make_reviews_resource(handler, max_retries=1)
        result = resource.get("gw_rev_001")
        assert result.id == "gw_rev_001"


class TestRetryOnRateLimit:
    @patch("gatewerk._base.time.sleep")
    def test_retries_on_429(self, mock_sleep):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(429, json={"error": {"message": "Rate limited"}})
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review"})

        resource = _make_reviews_resource(handler, max_retries=1)
        result = resource.get("gw_rev_001")
        assert result.id == "gw_rev_001"

    @patch("gatewerk._base.time.sleep")
    def test_respects_retry_after_header(self, mock_sleep):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(429, json={"error": {"message": "Rate limited"}}, headers={"retry-after": "2.5"})
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review"})

        resource = _make_reviews_resource(handler, max_retries=1)
        resource.get("gw_rev_001")
        mock_sleep.assert_called_once()
        assert mock_sleep.call_args[0][0] == 2.5

    @patch("gatewerk._base.time.sleep")
    def test_429_exhausted_raises_rate_limit_error(self, mock_sleep):
        def handler(request: httpx.Request):
            return httpx.Response(429, json={"error": {"message": "Rate limited"}}, headers={"retry-after": "1"})

        resource = _make_reviews_resource(handler, max_retries=2)
        with pytest.raises(RateLimitError) as exc_info:
            resource.get("gw_rev_001")
        assert exc_info.value.retry_after == 1.0


class TestNoRetryOn4xx:
    def test_400_not_retried(self):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            return httpx.Response(400, json={"error": {"message": "Bad request"}})

        resource = _make_reviews_resource(handler, max_retries=2)
        with pytest.raises(GatewerkError):
            resource.get("gw_rev_001")
        assert attempts == 1

    def test_404_not_retried(self):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            return httpx.Response(404, json={"error": {"message": "Not found"}})

        resource = _make_reviews_resource(handler, max_retries=2)
        with pytest.raises(GatewerkError):
            resource.get("gw_rev_001")
        assert attempts == 1


class TestRetryDisabled:
    def test_max_retries_zero_no_retry(self):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            return httpx.Response(500, json={"error": {"message": "Server error"}})

        resource = _make_reviews_resource(handler, max_retries=0)
        with pytest.raises(GatewerkError):
            resource.get("gw_rev_001")
        assert attempts == 1


# ---------------------------------------------------------------------------
# Async retry tests
# ---------------------------------------------------------------------------


class TestAsyncRetryOnServerError:
    @pytest.mark.asyncio
    @patch("gatewerk._base.asyncio.sleep")
    async def test_retries_on_500_then_succeeds(self, mock_sleep):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                return httpx.Response(500, json={"error": {"message": "Server error"}})
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review"})

        resource = _make_async_reviews_resource(handler, max_retries=2)
        result = await resource.get("gw_rev_001")

        assert isinstance(result, Review)
        assert attempts == 3
        assert mock_sleep.call_count == 2

    @pytest.mark.asyncio
    @patch("gatewerk._base.asyncio.sleep")
    async def test_exhausts_retries_then_raises(self, mock_sleep):
        def handler(request: httpx.Request):
            return httpx.Response(500, json={"error": {"message": "Server error"}})

        resource = _make_async_reviews_resource(handler, max_retries=2)
        with pytest.raises(GatewerkError, match="Server error"):
            await resource.get("gw_rev_001")
        assert mock_sleep.call_count == 2

    @pytest.mark.asyncio
    @patch("gatewerk._base.asyncio.sleep")
    async def test_retries_on_502(self, mock_sleep):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(502, text="Bad Gateway")
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review"})

        resource = _make_async_reviews_resource(handler, max_retries=1)
        result = await resource.get("gw_rev_001")
        assert result.id == "gw_rev_001"


class TestAsyncRetryOnRateLimit:
    @pytest.mark.asyncio
    @patch("gatewerk._base.asyncio.sleep")
    async def test_retries_on_429(self, mock_sleep):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(429, json={"error": {"message": "Rate limited"}})
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review"})

        resource = _make_async_reviews_resource(handler, max_retries=1)
        result = await resource.get("gw_rev_001")
        assert result.id == "gw_rev_001"

    @pytest.mark.asyncio
    @patch("gatewerk._base.asyncio.sleep")
    async def test_respects_retry_after_header(self, mock_sleep):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(429, json={"error": {"message": "Rate limited"}}, headers={"retry-after": "3.0"})
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review"})

        resource = _make_async_reviews_resource(handler, max_retries=1)
        await resource.get("gw_rev_001")
        mock_sleep.assert_called_once()
        assert mock_sleep.call_args[0][0] == 3.0

    @pytest.mark.asyncio
    @patch("gatewerk._base.asyncio.sleep")
    async def test_429_exhausted_raises_rate_limit_error(self, mock_sleep):
        def handler(request: httpx.Request):
            return httpx.Response(429, json={"error": {"message": "Rate limited"}}, headers={"retry-after": "1"})

        resource = _make_async_reviews_resource(handler, max_retries=2)
        with pytest.raises(RateLimitError) as exc_info:
            await resource.get("gw_rev_001")
        assert exc_info.value.retry_after == 1.0


class TestAsyncNoRetryOn4xx:
    @pytest.mark.asyncio
    async def test_400_not_retried(self):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            return httpx.Response(400, json={"error": {"message": "Bad request"}})

        resource = _make_async_reviews_resource(handler, max_retries=2)
        with pytest.raises(GatewerkError):
            await resource.get("gw_rev_001")
        assert attempts == 1


class TestAsyncRetryDisabled:
    @pytest.mark.asyncio
    async def test_max_retries_zero_no_retry(self):
        attempts = 0

        def handler(request: httpx.Request):
            nonlocal attempts
            attempts += 1
            return httpx.Response(500, json={"error": {"message": "Server error"}})

        resource = _make_async_reviews_resource(handler, max_retries=0)
        with pytest.raises(GatewerkError):
            await resource.get("gw_rev_001")
        assert attempts == 1


# ---------------------------------------------------------------------------
# 204 No Content handling
# ---------------------------------------------------------------------------


class TestNoContentHandling:
    def test_204_returns_empty_dict(self):
        def handler(request: httpx.Request):
            return httpx.Response(204)

        from gatewerk.resources.stats import StatsResource

        transport = httpx.MockTransport(handler)
        http = httpx.Client(transport=transport, base_url="http://test:3100")
        resource = StatsResource(http, max_retries=0)
        result = resource.get()
        assert result == {}

    def test_200_empty_body_returns_empty_dict(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, content=b"")

        from gatewerk.resources.stats import StatsResource

        transport = httpx.MockTransport(handler)
        http = httpx.Client(transport=transport, base_url="http://test:3100")
        resource = StatsResource(http, max_retries=0)
        result = resource.get()
        assert result == {}

    @pytest.mark.asyncio
    async def test_async_204_returns_empty_dict(self):
        def handler(request: httpx.Request):
            return httpx.Response(204)

        from gatewerk.async_client import AsyncStatsResource

        transport = httpx.MockTransport(handler)
        http = httpx.AsyncClient(transport=transport, base_url="http://test:3100")
        resource = AsyncStatsResource(http, max_retries=0)
        result = await resource.get()
        assert result == {}
