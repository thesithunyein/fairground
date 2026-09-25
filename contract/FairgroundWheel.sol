// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ICasinoGameV2, SessionContext, SessionPhase, StepResult } from "../solidity/ICasinoGameV2.sol";

/// @title FairgroundWheel — Chain Jam Vol. 1 entry "FAIRGROUND"
/// @notice The honest carnival: a uniformly random wheel whose PAYOUT TABLE the
///         player paints before every spin. Probabilities are never negotiable —
///         one VRF word, rejection-sampled to an exactly-uniform segment — but
///         the paytable is yours: paint segments safe (0.2×), mid (2λ×) or risky
///         (6λ×) and the contract derives λ so the wheel returns exactly
///         RTP = 96% for every legal paint.
///
/// Instant game shape: open → WAITING_RANDOMNESS → settle. No player actions.
///
/// gameData (9 bytes, mirroring src/lib/game.ts exactly):
///   byte 0     : segmentCount N (8..16, even)
///   bytes 1..8 : two 4-bit tiers per byte, low nibble = segment 2i,
///                high nibble = segment 2i+1  (0 safe, 1 mid, 2 risky)
///
/// Legality (revert otherwise):
///   every tier ≤ 2; cRisky ≥ 1; cSafe + cMid ≥ 1; 2·cRisky ≤ N
///
/// Pricing (all WAD 1e18):
///   SAFE = 0.2e18 (anchor); MID = 2λ; RISKY = 6λ;
///   λ = (RTP·N − 0.2·cSafe) / (2·cMid + 6·cRisky), floored.
///   On the legal space λ ≥ 0.24e18 so 0.2 < 2λ < 6λ always holds.
///   Heaviest legal paint (N=16, 1 risky): RISKY ≈ 12.36× — light-tail for the
///   vault (max payout/wager < 100, risky probability ≥ 1/16 ≥ 0.1%).
///   Body variance (quoteRiskParams) is quoted for real, not hardcoded: on the
///   safest paints the MID tier also pays above 1× (2λ > 1), making it a second
///   winning tier with genuine spread — see _bodyVarianceScaled. When mid pays at
///   most the stake the risky tier is the sole winning tier and it is exactly 0.
///
/// Randomness mapping (RANDOMNESS_DICE.md rules):
///   limit(N) = floor(256/N)·N; first byte < limit → segment = b % N.
///   Prize (cosmetic, payout-neutral): the byte AFTER the segment byte,
///   toyId = b % 6, rarity by value (b < 196 common, < 246 rare, else legendary).
///   Payout depends ONLY on the segment byte — proven by tests.
contract FairgroundWheel is ICasinoGameV2 {
    uint256 public constant RTP_WAD = 0.96e18;
    uint256 public constant SAFE_ANCHOR_WAD = 0.2e18;
    /// Tier weights — PLAIN (not WAD-scaled): MID = 2·λ, RISKY = 6·λ with λ in WAD.
    uint256 public constant MID_WEIGHT = 2;
    uint256 public constant RISKY_WEIGHT = 6;
    uint256 public constant MAX_MULTIPLIER_WAD = 16e18;
    uint256 public constant MAX_SEGMENTS = 16;
    uint256 public constant MIN_SEGMENTS = 8;

    uint256 private constant WAD = 1e18;

    error Fairground__BadGameData();
    error Fairground__IllegalPaint();
    /// @dev Instant game: this contract never enters WAITING_PLAYER_ACTION, so
    ///      onPlayerAction must never be reached. Distinct from BadGameData so a
    ///      revert trace names the real fault instead of blaming the paint bytes.
    error Fairground__NoPlayerActions();

    // ── gameData decoding ───────────────────────────────────────────────────

    function _decodePaint(bytes calldata gameData) private pure returns (uint256 segmentCount, uint256[] memory tiers) {
        if (gameData.length != 9) revert Fairground__BadGameData();
        segmentCount = uint256(uint8(gameData[0]));
        if (segmentCount < MIN_SEGMENTS || segmentCount > MAX_SEGMENTS || segmentCount % 2 != 0) {
            revert Fairground__BadGameData();
        }
        tiers = new uint256[](segmentCount);
        for (uint256 i = 0; i < segmentCount; i += 2) {
            uint256 b = uint256(uint8(gameData[1 + (i >> 1)]));
            uint256 lo = b & 0x0f;
            uint256 hi = (b >> 4) & 0x0f;
            if (lo > 2 || hi > 2) revert Fairground__BadGameData();
            tiers[i] = lo;
            tiers[i + 1] = hi;
        }
    }

    function _counts(uint256[] memory tiers)
        private
        pure
        returns (uint256 cSafe, uint256 cMid, uint256 cRisky)
    {
        for (uint256 i = 0; i < tiers.length; i++) {
            if (tiers[i] == 0) cSafe++;
            else if (tiers[i] == 1) cMid++;
            else cRisky++;
        }
    }

    function _requireLegalPaint(uint256 segmentCount, uint256[] memory tiers) private pure {
        (uint256 cSafe, uint256 cMid, uint256 cRisky) = _counts(tiers);
        if (cRisky == 0) revert Fairground__IllegalPaint();
        if (cSafe + cMid == 0) revert Fairground__IllegalPaint();
        if (2 * cRisky > segmentCount) revert Fairground__IllegalPaint();
    }

    // ── pricing ─────────────────────────────────────────────────────────────

    /// @notice λ_WAD = (RTP·N − 0.2e18·cSafe) / (2·cMid + 6·cRisky), floored.
    /// The denominator is the plain weight sum — the numerator is already in
    /// WAD·multiplier units, so λ comes out in WAD directly.
    function _lambdaWad(uint256 segmentCount, uint256[] memory tiers) private pure returns (uint256) {
        (uint256 cSafe, uint256 cMid, uint256 cRisky) = _counts(tiers);
        uint256 numerator = RTP_WAD * segmentCount - SAFE_ANCHOR_WAD * cSafe;
        uint256 denominator = MID_WEIGHT * cMid + RISKY_WEIGHT * cRisky;
        return numerator / denominator;
    }

    function _priceWheel(uint256 segmentCount, uint256[] memory tiers)
        private
        pure
        returns (uint256 safe_, uint256 mid_, uint256 risky_)
    {
        safe_ = SAFE_ANCHOR_WAD;
        uint256 lambda = _lambdaWad(segmentCount, tiers);
        mid_ = MID_WEIGHT * lambda;
        risky_ = RISKY_WEIGHT * lambda;
    }

    function _multiplierFor(uint256 tier, uint256 segmentCount, uint256[] memory tiers)
        private
        pure
        returns (uint256)
    {
        (uint256 safe_, uint256 mid_, uint256 risky_) = _priceWheel(segmentCount, tiers);
        if (tier == 0) return safe_;
        if (tier == 1) return mid_;
        return risky_;
    }

    // ── ICasinoGameV2 ───────────────────────────────────────────────────────

    function quoteCaps(uint256 wager, bytes calldata gameData)
        external
        view
        returns (uint256 maxEscrowStake, uint256 maxReservedProfit)
    {
        (uint256 segmentCount, uint256[] memory tiers) = _decodePaint(gameData);
        _requireLegalPaint(segmentCount, tiers);
        maxEscrowStake = wager; // stake only — never pulls extra from the player
        uint256 maxPayout = _maxPayout(wager, segmentCount, tiers);
        maxReservedProfit = maxPayout > wager ? maxPayout - wager : 0;
    }

    function quoteRiskParams(uint256 wager, bytes calldata gameData)
        external
        view
        returns (
            uint256 maxPayout,
            uint256 probabilityWad,
            uint256 expectedPayout,
            uint256 bodyVarianceScaled
        )
    {
        (uint256 segmentCount, uint256[] memory tiers) = _decodePaint(gameData);
        _requireLegalPaint(segmentCount, tiers);
        (, , uint256 risky_) = _priceWheel(segmentCount, tiers);
        (, , uint256 cRisky) = _counts(tiers);

        maxPayout = (wager * risky_) / WAD;
        probabilityWad = (cRisky * WAD) / segmentCount; // risky tier win probability
        expectedPayout = (wager * RTP_WAD) / WAD; // exact by construction
        bodyVarianceScaled = _bodyVarianceScaled(wager, segmentCount, tiers);
    }

    function onSessionStart(SessionContext calldata ctx) external view returns (StepResult memory stepResult) {
        (uint256 segmentCount, uint256[] memory tiers) = _decodePaint(ctx.gameData);
        _requireLegalPaint(segmentCount, tiers);
        (, , uint256 risky_) = _priceWheel(segmentCount, tiers);
        if (risky_ > MAX_MULTIPLIER_WAD) revert Fairground__IllegalPaint();

        // This game's declared math caps the win probability at the risky tier,
        // so the worst-case total payout is the full risky-tier payout.
        uint256 maxPayout = (ctx.wagerBase * risky_) / WAD;
        uint256 reservedProfit = maxPayout > ctx.wagerBase ? maxPayout - ctx.wagerBase : 0;

        stepResult.newGameState = abi.encode(uint8(segmentCount), uint8(0) /* segment placeholder */);
        stepResult.escrowDelta = 0;
        stepResult.reservedProfitDelta = int256(reservedProfit);
        stepResult.nextPhase = SessionPhase.WAITING_RANDOMNESS;
        stepResult.requestRandomnessNow = true;
        stepResult.payout = 0;
    }

    function onPlayerAction(SessionContext calldata, bytes calldata) external pure returns (StepResult memory) {
        // Instant game — no player steps. The session never enters
        // WAITING_PLAYER_ACTION, so a host calling this is a protocol-level bug,
        // not a bad paint. Name it that way in the revert trace.
        revert Fairground__NoPlayerActions();
    }

    function onRandomness(SessionContext calldata ctx, bytes32 randomness)
        external
        pure
        returns (StepResult memory stepResult)
    {
        (uint256 segmentCount, uint256[] memory tiers) = _decodePaint(ctx.gameData);
        _requireLegalPaint(segmentCount, tiers);

        uint256 limit = (256 / segmentCount) * segmentCount; // 128 for N=8 … 240 for N=16

        // Rejection sampling over the VRF word — exactly uniform segment.
        uint256 segment = 0;
        bool found = false;
        for (uint256 i = 0; i < 32 && !found; i++) {
            uint256 b = uint256(uint8(randomness[i]));
            if (b < limit) {
                segment = b % segmentCount;
                found = true;
            }
        }
        // All 32 bytes rejected: p < 2^-32 per word with real VRF. Settlement
        // must never wedge, so fall back to the full word modulo N —
        // deterministic on-chain and mirrored exactly by the client.
        if (!found) {
            segment = uint256(randomness) % segmentCount;
        }

        uint256 tier = tiers[segment];
        uint256 multiplier = _multiplierFor(tier, segmentCount, tiers);
        uint256 payout = (ctx.wagerBase * multiplier) / WAD;

        stepResult.newGameState = abi.encode(uint8(segmentCount), uint8(segment));
        stepResult.escrowDelta = 0;
        // Keep the reservedProfit reservation in place through settlement:
        // _finalizeSession caps payout at escrowedStake + reservedProfit, and a
        // negative delta here would release the reservation BEFORE the cap is
        // checked, reverting every mid/risky win. (Reservation stays consumed
        // on the host's risk accounting; zeroing it here is the classic
        // instant-game bug.)
        stepResult.reservedProfitDelta = 0;
        stepResult.nextPhase = SessionPhase.SETTLED;
        stepResult.requestRandomnessNow = false;
        stepResult.payout = payout;
    }

    function quoteForfeitPayout(SessionContext calldata) external pure returns (uint256) {
        return 0; // instant game: nothing cashable mid-round
    }

    // ── internals ───────────────────────────────────────────────────────────

    function _maxPayout(uint256 wager, uint256 segmentCount, uint256[] memory tiers)
        private
        pure
        returns (uint256)
    {
        (, , uint256 risky_) = _priceWheel(segmentCount, tiers);
        return (wager * risky_) / WAD;
    }

    /// @notice Body variance: the variance of this bet's payout with the TOP
    ///         (risky) tier removed, per bet, in the reserve's scaled units
    ///         (wei² · 1e18), as `quoteRiskParams` must declare it.
    ///
    ///         The risky tier is the sole winning tier whenever MID pays at most
    ///         the stake back (2λ ≤ 1), and then this is exactly 0 — matching the
    ///         SDK definition for single-winning-tier games.
    ///
    ///         On the safest paints 2λ > 1, so MID is a SECOND winning tier and
    ///         carries real spread. With p = cMid/N and mid payout X, the non-top
    ///         payout is W = X·Bernoulli(p), hence
    ///             Var(W) = p(1−p)·X² = cMid·(N−cMid)·X² / N².
    ///         cMid·(N−cMid) ≤ 64 and N ≤ 16, so this stays far inside uint256 for
    ///         any wager the vault will accept.
    function _bodyVarianceScaled(uint256 wager, uint256 segmentCount, uint256[] memory tiers)
        private
        pure
        returns (uint256)
    {
        (, uint256 cMid, ) = _counts(tiers);
        if (cMid == 0) return 0; // nothing between safe and risky: single-tier wheel
        (, uint256 mid_, ) = _priceWheel(segmentCount, tiers);
        if (mid_ <= WAD) return 0; // mid pays at most the stake: not a winning tier

        uint256 payout = (wager * mid_) / WAD; // wei
        uint256 n = segmentCount;
        return (((cMid * (n - cMid)) * payout * payout) / (n * n)) * WAD;
    }
}
