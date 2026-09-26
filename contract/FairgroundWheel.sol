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
/// Round shape (3 steps, 2 VRF words):
///   1. open     → onSessionStart   → WAITING_RANDOMNESS   (word A: the segment)
///   2. word A   → onRandomness     → WAITING_PLAYER_ACTION
///   3. bank/ride→ onPlayerAction   → SETTLED | WAITING_RANDOMNESS
///   4. word B   → onRandomness     → SETTLED              (only after a ride)
///
/// @dev The ride is an EXACTLY FAIR double-or-nothing, and that single property
///      is what lets this game keep one clean promise: **RTP is 96.00% whatever
///      you paint and whatever you choose.**
///
///        BANK → payout = wager · m
///        RIDE → payout = 2·wager·m with probability 1/2, else 0
///
///      E[ride] = ½·2·m + ½·0 = m = E[bank], so the optional step is a pure
///      variance choice with zero house edge and the declared `expectedPayout`
///      stays exact for every strategy — the game has no "optimal play" caveat.
///
///      The ride coin comes from a SECOND VRF word, which does not exist when
///      the player chooses. That matters: the coin must be provably hidden at
///      decision time, otherwise a player (or a script) could read it out of the
///      session's first word and ride only when it wins.
///
/// gameData (9 bytes, mirroring src/lib/game.ts exactly):
///   byte 0     : segmentCount N (8..16, even)
///   bytes 1..8 : two 4-bit tiers per byte, low nibble = segment 2i,
///                high nibble = segment 2i+1  (0 safe, 1 mid, 2 risky)
///
/// gameState (3 abi-encoded bytes): (uint8 segmentCount, uint8 segment, uint8 stage)
///   stage 0 SPIN   — no segment yet, waiting for word A
///   stage 1 DECIDE — segment known, the player may bank or ride
///   stage 2 RIDE   — a ride was taken, waiting for word B (the coin)
///   stage 3 BANKED — settled by banking (terminal; kept for a readable trace)
///   `segment` is 0xFF while unknown.
///
/// actionData (1 byte): 0 = BANK, 1 = RIDE. Anything else reverts.
///
/// Legality (revert otherwise):
///   every tier ≤ 2; cRisky ≥ 1; cSafe + cMid ≥ 1; 2·cRisky ≤ N
///
/// Pricing (all WAD 1e18):
///   SAFE = 0.2e18 (anchor); MID = 2λ; RISKY = 6λ;
///   λ = (RTP·N − 0.2·cSafe) / (2·cMid + 6·cRisky), floored.
///   On the legal space λ ≥ 0.24e18 so 0.2 < 2λ < 6λ always holds.
///   Heaviest legal paint (N=16, 1 risky): RISKY ≈ 12.36×, and the worst-case
///   ride doubles it to ≈ 24.72× — still far under the vault's 100× heavy-tail
///   multiplier threshold, so the simple VaR path still applies.
///
/// Risk quoting: the host must commit risk before the player has decided, so
///   every declared quantity is the worst case over the player's choices (i.e.
///   the player rides). See quoteRiskParams.
///
/// Randomness mapping (RANDOMNESS_DICE.md rules):
///   segment: limit(N) = floor(256/N)·N; first byte < limit → segment = b % N.
///   ride coin: byte 0 of the ride word < 128 → win. Exactly 1/2, no bias.
///   Prize (cosmetic, payout-neutral): the byte AFTER the segment byte,
///   toyId = b % 6, rarity by value (b < 196 common, < 246 rare, else legendary).
///   Payout depends ONLY on the segment byte — proven by tests.
contract FairgroundWheel is ICasinoGameV2 {
    uint256 public constant RTP_WAD = 0.96e18;
    uint256 public constant SAFE_ANCHOR_WAD = 0.2e18;
    /// Tier weights — PLAIN (not WAD-scaled): MID = 2·λ, RISKY = 6·λ with λ in WAD.
    uint256 public constant MID_WEIGHT = 2;
    uint256 public constant RISKY_WEIGHT = 6;
    /// Base-tier ceiling. The worst-case payout on the heaviest legal paint is
    /// RIDE_FACTOR · RISKY ≈ 24.72×, still under the 100× heavy-tail threshold.
    uint256 public constant MAX_MULTIPLIER_WAD = 16e18;
    uint256 public constant MAX_SEGMENTS = 16;
    uint256 public constant MIN_SEGMENTS = 8;
    /// A winning ride doubles the landed multiplier. Paired with a 1/2 coin this
    /// is exactly fair — see the contract notice.
    uint256 public constant RIDE_FACTOR = 2;
    /// The ride coin wins on half the byte range: exactly 1/2, no rejection needed.
    uint256 public constant RIDE_WIN_LIMIT = 128;

    uint256 private constant WAD = 1e18;

    uint8 private constant STAGE_SPIN = 0;
    uint8 private constant STAGE_DECIDE = 1;
    uint8 private constant STAGE_RIDE = 2;
    uint8 private constant STAGE_BANKED = 3;
    uint8 private constant SEGMENT_UNKNOWN = 0xff;

    uint8 private constant ACTION_BANK = 0;
    uint8 private constant ACTION_RIDE = 1;

    error Fairground__BadGameData();
    error Fairground__IllegalPaint();
    error Fairground__BadGameState();
    error Fairground__BadAction();
    /// @dev A step handler reached out of order — the host drives the phase
    ///      machine, so this is a protocol-level fault, not a bad paint.
    error Fairground__WrongStep();

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

    // ── gameState encoding ──────────────────────────────────────────────────

    function _encodeState(uint256 segmentCount, uint8 segment, uint8 stage) private pure returns (bytes memory) {
        return abi.encode(uint8(segmentCount), segment, stage);
    }

    /// @dev Only the stage and the segment are read back; the segment count is
    ///      re-derived from gameData, which is the authoritative paint.
    function _decodeState(bytes calldata gameState) private pure returns (uint8 segment, uint8 stage) {
        if (gameState.length != 96) revert Fairground__BadGameState();
        (, segment, stage) = abi.decode(gameState, (uint8, uint8, uint8));
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

    /// @notice THE payout function. quoteCaps, quoteRiskParams, onSessionStart,
    ///         onPlayerAction and onRandomness all compute money through this
    ///         one expression, so the reserved budget and the paid amount agree
    ///         to the wei and a top-multiplier win can never round one base unit
    ///         above its own reserve (see CONTRACT_CONSTRAINTS.md).
    function _payoutFor(uint256 wager, uint256 multiplierWad) private pure returns (uint256) {
        return (wager * multiplierWad) / WAD;
    }

    /// @notice Worst-case payout of a whole round: the ride doubling the heaviest
    ///         tier. Written as `RIDE_FACTOR * _payoutFor(...)` rather than as a
    ///         single scaled division, so it is exactly the same arithmetic the
    ///         settling step uses.
    function _maxPayoutWithRide(uint256 wager, uint256 risky_) private pure returns (uint256) {
        return RIDE_FACTOR * _payoutFor(wager, risky_);
    }

    function _reservedProfit(uint256 wager, uint256 maxPayout) private pure returns (uint256) {
        return maxPayout > wager ? maxPayout - wager : 0;
    }

    // ── ICasinoGameV2 ───────────────────────────────────────────────────────

    function quoteCaps(uint256 wager, bytes calldata gameData)
        external
        view
        returns (uint256 maxEscrowStake, uint256 maxReservedProfit)
    {
        (uint256 segmentCount, uint256[] memory tiers) = _decodePaint(gameData);
        _requireLegalPaint(segmentCount, tiers);
        maxEscrowStake = wager; // stake only — the ride never asks for more money
        (, , uint256 risky_) = _priceWheel(segmentCount, tiers);
        maxReservedProfit = _reservedProfit(wager, _maxPayoutWithRide(wager, risky_));
    }

    /// @notice Worst case over the player's choices, because the host commits
    ///         risk before the player decides. A riding player is the expensive
    ///         one: they double the worst tier and halve its probability.
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

        maxPayout = _maxPayoutWithRide(wager, risky_);
        // The top payout needs the heaviest tier AND a winning coin: cRisky/N · 1/2.
        probabilityWad = (cRisky * WAD) / (2 * segmentCount);
        // Policy-free and exact: the ride is fair, so this equals the mean payout
        // of every strategy the player can pick.
        expectedPayout = (wager * RTP_WAD) / WAD;
        bodyVarianceScaled = _bodyVarianceScaled(wager, segmentCount, tiers);
    }

    function onSessionStart(SessionContext calldata ctx) external view returns (StepResult memory stepResult) {
        (uint256 segmentCount, uint256[] memory tiers) = _decodePaint(ctx.gameData);
        _requireLegalPaint(segmentCount, tiers);
        (, , uint256 risky_) = _priceWheel(segmentCount, tiers);
        if (risky_ > MAX_MULTIPLIER_WAD) revert Fairground__IllegalPaint();

        // Reserve the whole ride, up front: the settlement step must already fit
        // inside escrowedStake + reservedProfit at every point in the round.
        uint256 maxPayout = _maxPayoutWithRide(ctx.wagerBase, risky_);

        stepResult.newGameState = _encodeState(segmentCount, SEGMENT_UNKNOWN, STAGE_SPIN);
        stepResult.escrowDelta = 0;
        stepResult.reservedProfitDelta = int256(_reservedProfit(ctx.wagerBase, maxPayout));
        stepResult.nextPhase = SessionPhase.WAITING_RANDOMNESS;
        stepResult.requestRandomnessNow = true;
        stepResult.payout = 0;
    }

    function onPlayerAction(SessionContext calldata ctx, bytes calldata actionData)
        external
        pure
        returns (StepResult memory stepResult)
    {
        (uint256 segmentCount, uint256[] memory tiers) = _decodePaint(ctx.gameData);
        _requireLegalPaint(segmentCount, tiers);
        (uint8 segment, uint8 stage) = _decodeState(ctx.gameState);
        if (stage != STAGE_DECIDE) revert Fairground__WrongStep();
        if (actionData.length != 1) revert Fairground__BadAction();

        uint256 multiplier = _multiplierFor(tiers[segment], segmentCount, tiers);

        if (uint8(actionData[0]) == ACTION_BANK) {
            stepResult.newGameState = _encodeState(segmentCount, segment, STAGE_BANKED);
            stepResult.escrowDelta = 0;
            // Never release the reservation on a settling step: _finalizeSession
            // caps the payout at escrowedStake + reservedProfit, so a negative
            // delta here would drop the cap to the stake and revert the win.
            stepResult.reservedProfitDelta = 0;
            stepResult.nextPhase = SessionPhase.SETTLED;
            stepResult.requestRandomnessNow = false;
            stepResult.payout = _payoutFor(ctx.wagerBase, multiplier);
        } else if (uint8(actionData[0]) == ACTION_RIDE) {
            // Nothing is paid yet, and the reservation must survive to the end of
            // the round, because the coin can still pay the doubled multiplier.
            stepResult.newGameState = _encodeState(segmentCount, segment, STAGE_RIDE);
            stepResult.escrowDelta = 0;
            stepResult.reservedProfitDelta = 0;
            stepResult.nextPhase = SessionPhase.WAITING_RANDOMNESS;
            stepResult.requestRandomnessNow = true;
            stepResult.payout = 0;
        } else {
            revert Fairground__BadAction();
        }
    }

    function onRandomness(SessionContext calldata ctx, bytes32 randomness)
        external
        pure
        returns (StepResult memory stepResult)
    {
        (uint256 segmentCount, uint256[] memory tiers) = _decodePaint(ctx.gameData);
        _requireLegalPaint(segmentCount, tiers);
        (uint8 segment, uint8 stage) = _decodeState(ctx.gameState);

        uint256 payout = 0;
        SessionPhase nextPhase;

        if (stage == STAGE_SPIN) {
            // Word A: the wheel itself.
            uint256 landed = _segmentFromRandomness(randomness, segmentCount);
            stepResult.newGameState = _encodeState(segmentCount, uint8(landed), STAGE_DECIDE);
            nextPhase = SessionPhase.WAITING_PLAYER_ACTION;
        } else if (stage == STAGE_RIDE) {
            // Word B: the ride coin. This word did not exist when the player
            // chose to ride, which is what makes the decision real.
            bool won = uint256(uint8(randomness[0])) < RIDE_WIN_LIMIT;
            if (won) {
                uint256 multiplier = _multiplierFor(tiers[segment], segmentCount, tiers);
                payout = RIDE_FACTOR * _payoutFor(ctx.wagerBase, multiplier);
            }
            stepResult.newGameState = _encodeState(segmentCount, segment, STAGE_RIDE);
            nextPhase = SessionPhase.SETTLED;
        } else {
            revert Fairground__WrongStep();
        }

        stepResult.escrowDelta = 0;
        // Keep the reservation in place through settlement — _finalizeSession
        // releases it. See onPlayerAction.
        stepResult.reservedProfitDelta = 0;
        stepResult.nextPhase = nextPhase;
        stepResult.requestRandomnessNow = false;
        stepResult.payout = payout;
    }

    /// @notice Mid-round cash-out value. The only phase a host may forfeit from is
    ///         WAITING_PLAYER_ACTION, and there the player genuinely holds a
    ///         bankable amount (the landed segment's multiplier), so quoting it
    ///         is not adverse selection — it is the option the player already has.
    ///         While a ride is in flight the value is unresolved, so it is 0.
    function quoteForfeitPayout(SessionContext calldata ctx) external pure returns (uint256) {
        (uint256 segmentCount, uint256[] memory tiers) = _decodePaint(ctx.gameData);
        (uint8 segment, uint8 stage) = _decodeState(ctx.gameState);
        if (stage != STAGE_DECIDE) return 0;
        return _payoutFor(ctx.wagerBase, _multiplierFor(tiers[segment], segmentCount, tiers));
    }

    // ── internals ───────────────────────────────────────────────────────────

    /// @notice Rejection-sampled uniform segment over the VRF word, mirrored
    ///         exactly by src/lib/game.ts.
    function _segmentFromRandomness(bytes32 randomness, uint256 segmentCount) private pure returns (uint256) {
        uint256 limit = (256 / segmentCount) * segmentCount; // 128 for N=8 … 240 for N=16
        for (uint256 i = 0; i < 32; i++) {
            uint256 b = uint256(uint8(randomness[i]));
            if (b < limit) return b % segmentCount;
        }
        // All 32 bytes rejected: p < 2^-32 per word with real VRF. Settlement
        // must never wedge, so fall back to the full word modulo N —
        // deterministic on-chain and mirrored exactly by the client.
        return uint256(randomness) % segmentCount;
    }

    /// @notice Body variance: the variance of this round's payout with the TOP
    ///         (risky) tier removed, per bet, in the reserve's scaled units
    ///         (wei² · 1e18), as `quoteRiskParams` must declare it.
    ///
    ///         The top tier is the one whose probability is `probabilityWad`, so
    ///         removing it here is exactly what keeps the on-chain binary term
    ///         and this body term from double counting.
    ///
    ///         What is left is SAFE and MID. SAFE pays at most 0.4× even doubled,
    ///         so only MID can survive as a winning outcome — that is what "the
    ///         top tier is the sole winning outcome" means, and then this is 0.
    ///
    ///         Taken under the worst-case policy (the player rides), the surviving
    ///         payout is the doubled mid multiplier times two independent and
    ///         unbiased coin flips: B ~ Bernoulli(p) that MID is landed, p = cMid/N,
    ///         and K ~ Bernoulli(1/2) that the fair ride wins. With X the mid
    ///         payout and E[K] = 1/2, E[K²] = 1/2·(RIDE_FACTOR²) = 2:
    ///
    ///           E[BKX]  = XP,  E[(BKX)²] = 2X²P   (P = p)
    ///           Var     = XP · (2X − XP) = X² · p · (2 − p)
    ///
    ///         Dropping the ride's coin (K ≡ 1) recovers the bank-only form
    ///         X²·p·(1−p), so this is the same measure with the ride folded in.
    function _bodyVarianceScaled(uint256 wager, uint256 segmentCount, uint256[] memory tiers)
        private
        pure
        returns (uint256)
    {
        (, uint256 cMid, ) = _counts(tiers);
        if (cMid == 0) return 0; // nothing between safe and risky: single-tier wheel
        (, uint256 mid_, ) = _priceWheel(segmentCount, tiers);
        // The doubled mid must beat the stake to count as a winning outcome.
        if (mid_ <= WAD / RIDE_FACTOR) return 0;

        uint256 payout = _payoutFor(wager, mid_); // wei
        uint256 n = segmentCount;
        // X² · cMid · (2N − cMid) / N²   ==   X² · p · (2 − p)
        return (((payout * payout) * cMid * (2 * n - cMid)) / (n * n)) * WAD;
    }
}
