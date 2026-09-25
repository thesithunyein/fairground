// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

enum SessionPhase {
  NONE,
  WAITING_RANDOMNESS,
  WAITING_PLAYER_ACTION,
  SETTLED,
  FORFEITED,
  CANCELLED
}

struct SessionContext {
  uint256 sessionId;
  address player;
  address vault;
  uint256 wagerBase;
  uint256 escrowedStake;
  uint256 reservedProfit;
  uint32 step;
  bytes gameData;
  bytes gameState;
}

struct StepResult {
  bytes newGameState;
  int256 escrowDelta;
  int256 reservedProfitDelta;
  SessionPhase nextPhase;
  bool requestRandomnessNow;
  uint256 payout;
}

interface ICasinoGameV2 {
  function quoteCaps(
    uint256 wager,
    bytes calldata gameData
  ) external view returns (uint256 maxEscrowStake, uint256 maxReservedProfit);

  /// @notice Risk parameters for portfolio VaR. `probabilityWad` is the top-tier win probability in WAD (1e18 = 100%).
  /// @notice `bodyVarianceScaled` is the variance of this bet's payout with the top tier removed, per bet, in the
  ///         reserve's scaled units (token^2 * 1e18, i.e. wei^2 * 1e18). It is added to the top-tier binary variance
  ///         for every bet, heavy-tail or not; a game with a single winning tier returns 0.
  function quoteRiskParams(
    uint256 wager,
    bytes calldata gameData
  )
    external
    view
    returns (
      uint256 maxPayout,
      uint256 probabilityWad,
      uint256 expectedPayout,
      uint256 bodyVarianceScaled
    );

  function onSessionStart(
    SessionContext calldata ctx
  ) external view returns (StepResult memory);

  function onPlayerAction(
    SessionContext calldata ctx,
    bytes calldata actionData
  ) external view returns (StepResult memory);

  function onRandomness(
    SessionContext calldata ctx,
    bytes32 randomness
  ) external view returns (StepResult memory);

  /// @notice Current cash-out value (stake + accrued winnings) of an in-progress session,
  ///         derived from `ctx.gameState`. Called by the host when forfeiting an abandoned
  ///         session so the player keeps most of their current winnings instead of losing
  ///         the whole stake. Return 0 when nothing is cashable mid-round.
  function quoteForfeitPayout(SessionContext calldata ctx) external view returns (uint256 cashoutValue);
}
