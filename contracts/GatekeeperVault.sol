// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GatekeeperVault
/// @notice An AI gatekeeper guards a pot of $WIF. Players pay a fee to send it one message.
///         Refused attempts are split between a burn and the pot. If the gatekeeper is
///         convinced, the player takes most of the pot and a new round starts.
///         Every message and every reply is emitted on-chain.
/// @dev The owner can never withdraw the pot. The gatekeeper key can only rule on attempts.
///      If the gatekeeper goes silent, any pending attempt can be refunded after `timeout`.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IBurnable {
    function burn(uint256 amount) external;
}

contract GatekeeperVault {
    // ------------------------------------------------------------------ constants
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_MESSAGE_BYTES = 1_000;
    uint256 public constant MAX_REPLY_BYTES = 1_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint8 public constant STATUS_NONE = 0;
    uint8 public constant STATUS_PENDING = 1;
    uint8 public constant STATUS_REFUSED = 2;
    uint8 public constant STATUS_OPENED = 3;
    uint8 public constant STATUS_REFUNDED = 4;

    // ------------------------------------------------------------------ config
    IERC20 public immutable wif;
    uint256 public immutable burnBps;   // share of a refused fee that is burned
    uint256 public immutable winnerBps; // share of the pot paid to a winner, rest seeds next round

    address public owner;
    address public gatekeeper;
    bool public paused;

    uint256 public baseFee;    // fee for the first attempt of a round
    uint256 public feeStepBps; // fee grows by this much per attempt in a round
    uint256 public maxFee;     // fee cap
    uint256 public timeout;    // seconds before an unruled attempt can be refunded

    // ------------------------------------------------------------------ state
    struct Attempt {
        address player;
        uint64 round;
        uint64 createdAt;
        uint8 status;
        uint256 fee;
    }

    Attempt[] internal _attempts;

    uint256 public round = 1;
    uint256 public pot;            // $WIF the winner can take
    uint256 public pending;        // fees held for attempts not yet ruled
    uint256 public roundAttempts;  // attempts made in the current round
    uint256 public totalBurned;
    uint256 public totalAttempts;

    uint256 private _lock = 1;

    // ------------------------------------------------------------------ events
    event Attempted(uint256 indexed id, uint256 indexed round, address indexed player, uint256 fee, string message);
    event Refused(uint256 indexed id, uint256 indexed round, address indexed player, uint256 burned, uint256 toPot, string reply);
    event Opened(uint256 indexed id, uint256 indexed round, address indexed winner, uint256 payout, uint256 carried, string reply);
    event Refunded(uint256 indexed id, address indexed player, uint256 fee);
    event Seeded(address indexed from, uint256 amount);
    event GatekeeperSet(address gatekeeper);
    event OwnerSet(address owner);
    event PausedSet(bool paused);
    event FeesSet(uint256 baseFee, uint256 feeStepBps, uint256 maxFee);
    event TimeoutSet(uint256 timeout);

    // ------------------------------------------------------------------ errors
    error NotOwner();
    error NotGatekeeper();
    error IsPaused();
    error BadMessage();
    error BadReply();
    error FeeTooHigh(uint256 fee, uint256 maxAccepted);
    error NotPending();
    error WrongRound();
    error TooEarly();
    error TransferFailed();
    error BadConfig();
    error Reentrant();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGatekeeper() {
        if (msg.sender != gatekeeper) revert NotGatekeeper();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        address wif_,
        address gatekeeper_,
        uint256 baseFee_,
        uint256 feeStepBps_,
        uint256 maxFee_,
        uint256 burnBps_,
        uint256 winnerBps_,
        uint256 timeout_
    ) {
        if (wif_ == address(0) || gatekeeper_ == address(0)) revert BadConfig();
        if (burnBps_ > BPS || winnerBps_ > BPS || winnerBps_ == 0) revert BadConfig();
        if (baseFee_ == 0 || maxFee_ < baseFee_) revert BadConfig();
        if (timeout_ < 5 minutes) revert BadConfig();

        wif = IERC20(wif_);
        burnBps = burnBps_;
        winnerBps = winnerBps_;
        owner = msg.sender;
        gatekeeper = gatekeeper_;
        baseFee = baseFee_;
        feeStepBps = feeStepBps_;
        maxFee = maxFee_;
        timeout = timeout_;

        emit OwnerSet(msg.sender);
        emit GatekeeperSet(gatekeeper_);
        emit FeesSet(baseFee_, feeStepBps_, maxFee_);
        emit TimeoutSet(timeout_);
    }

    // ------------------------------------------------------------------ views
    /// @notice Fee for the next attempt in the current round.
    function currentFee() public view returns (uint256) {
        uint256 f = (baseFee * (BPS + feeStepBps * roundAttempts)) / BPS;
        return f > maxFee ? maxFee : f;
    }

    function attemptCount() external view returns (uint256) {
        return _attempts.length;
    }

    function getAttempt(uint256 id) external view returns (Attempt memory) {
        return _attempts[id];
    }

    // ------------------------------------------------------------------ players
    /// @notice Pay the current fee and send the gatekeeper one message.
    /// @param message Your argument. Stored on-chain in the Attempted event.
    /// @param maxFeeAccepted Reverts if the fee rose above this before your tx landed.
    function attempt(string calldata message, uint256 maxFeeAccepted) external nonReentrant returns (uint256 id) {
        if (paused) revert IsPaused();
        uint256 len = bytes(message).length;
        if (len == 0 || len > MAX_MESSAGE_BYTES) revert BadMessage();

        uint256 fee = currentFee();
        if (fee > maxFeeAccepted) revert FeeTooHigh(fee, maxFeeAccepted);

        uint256 received = _pull(msg.sender, fee);

        id = _attempts.length;
        _attempts.push(
            Attempt({
                player: msg.sender,
                round: uint64(round),
                createdAt: uint64(block.timestamp),
                status: STATUS_PENDING,
                fee: received
            })
        );
        pending += received;
        roundAttempts += 1;
        totalAttempts += 1;

        emit Attempted(id, round, msg.sender, received, message);
    }

    /// @notice Add $WIF to the pot. Anyone can sweeten it.
    function seed(uint256 amount) external nonReentrant {
        uint256 received = _pull(msg.sender, amount);
        pot += received;
        emit Seeded(msg.sender, received);
    }

    /// @notice If the gatekeeper has not ruled within `timeout`, the player gets the full fee back.
    ///         Anyone can call it; the refund always goes to the player.
    function refund(uint256 id) external nonReentrant {
        Attempt storage a = _attempts[id];
        if (a.status != STATUS_PENDING) revert NotPending();
        if (block.timestamp < uint256(a.createdAt) + timeout) revert TooEarly();

        a.status = STATUS_REFUNDED;
        pending -= a.fee;
        _send(a.player, a.fee);
        emit Refunded(id, a.player, a.fee);
    }

    /// @notice Tokens sent to the vault directly (not via seed) are added to the pot.
    function syncExcess() external nonReentrant {
        uint256 bal = wif.balanceOf(address(this));
        uint256 tracked = pot + pending;
        if (bal > tracked) {
            uint256 extra = bal - tracked;
            pot += extra;
            emit Seeded(address(0), extra);
        }
    }

    // ------------------------------------------------------------------ gatekeeper
    /// @notice The gatekeeper's verdict on one attempt.
    function rule(uint256 id, bool open, string calldata reply) external onlyGatekeeper nonReentrant {
        uint256 rlen = bytes(reply).length;
        if (rlen == 0 || rlen > MAX_REPLY_BYTES) revert BadReply();

        Attempt storage a = _attempts[id];
        if (a.status != STATUS_PENDING) revert NotPending();

        uint256 fee = a.fee;
        pending -= fee;

        if (!open) {
            a.status = STATUS_REFUSED;
            uint256 burnAmt = (fee * burnBps) / BPS;
            uint256 toPot = fee - burnAmt;
            pot += toPot;
            if (burnAmt > 0) _burn(burnAmt);
            emit Refused(id, a.round, a.player, burnAmt, toPot, reply);
            return;
        }

        // Only an attempt from the live round can win the live pot.
        if (a.round != round) revert WrongRound();

        a.status = STATUS_OPENED;
        uint256 total = pot + fee; // the winning fee joins the pot, nothing burned
        uint256 payout = (total * winnerBps) / BPS;
        uint256 carried = total - payout;

        pot = carried;
        round += 1;
        roundAttempts = 0;

        _send(a.player, payout);
        emit Opened(id, a.round, a.player, payout, carried, reply);
    }

    // ------------------------------------------------------------------ owner
    function setGatekeeper(address g) external onlyOwner {
        if (g == address(0)) revert BadConfig();
        gatekeeper = g;
        emit GatekeeperSet(g);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @dev Players are protected from fee changes by `maxFeeAccepted`.
    function setFees(uint256 baseFee_, uint256 feeStepBps_, uint256 maxFee_) external onlyOwner {
        if (baseFee_ == 0 || maxFee_ < baseFee_) revert BadConfig();
        baseFee = baseFee_;
        feeStepBps = feeStepBps_;
        maxFee = maxFee_;
        emit FeesSet(baseFee_, feeStepBps_, maxFee_);
    }

    /// @dev Can only be lowered, so players are never locked out longer than promised.
    function setTimeout(uint256 t) external onlyOwner {
        if (t < 5 minutes || t > timeout) revert BadConfig();
        timeout = t;
        emit TimeoutSet(t);
    }

    function transferOwnership(address o) external onlyOwner {
        if (o == address(0)) revert BadConfig();
        owner = o;
        emit OwnerSet(o);
    }

    // ------------------------------------------------------------------ internal
    function _pull(address from, uint256 amount) internal returns (uint256 received) {
        uint256 before = wif.balanceOf(address(this));
        _call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        received = wif.balanceOf(address(this)) - before;
        if (received == 0) revert TransferFailed();
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        _call(abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    /// @dev Prefer the token's own burn(); fall back to the dead address if it has none.
    function _burn(uint256 amount) internal {
        uint256 before = wif.balanceOf(address(this));
        try IBurnable(address(wif)).burn(amount) {
            if (before - wif.balanceOf(address(this)) != amount) revert TransferFailed();
        } catch {
            _send(DEAD, amount);
        }
        totalBurned += amount;
    }

    /// @dev Handles tokens that return nothing or false.
    function _call(bytes memory data) internal {
        (bool ok, bytes memory ret) = address(wif).call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
