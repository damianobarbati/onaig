// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Ledger {
  uint256 public constant INITIAL_BALANCE = 10_000;
  address public constant P256_PRECOMPILE = address(0x100);

  struct User {
    string username;
    bytes32 x;
    bytes32 y;
    uint256 balance;
    uint256 nonce;
    uint256 createdAt;
    bool exists;
  }

  mapping(bytes32 => User) private users;
  bytes32[] private userKeys;

  event UserRegistered(bytes32 indexed publicKeyHash, string username, bytes32 x, bytes32 y, uint256 balance);

  event FundsTransferred(bytes32 indexed from, bytes32 indexed to, uint256 amount, uint256 nonce);

  error UserAlreadyRegistered();
  error UserNotFound();
  error InvalidSignature();
  error InvalidAmount();
  error InsufficientBalance();
  error InvalidNonce();
  error TransactionExpired();
  error InvalidUsername();

  function registerUser(string calldata username, bytes32 x, bytes32 y, bytes32 r, bytes32 s) external {
    if (bytes(username).length == 0 || bytes(username).length > 64) {
      revert InvalidUsername();
    }

    bytes32 keyHash = _publicKeyHash(x, y);

    if (users[keyHash].exists) {
      revert UserAlreadyRegistered();
    }

    bytes32 digest = sha256(abi.encode("PASSKEY_REGISTER", address(this), block.chainid, username, x, y));

    emit UserRegistered(keyHash, username, x, y, INITIAL_BALANCE);

    if (!_verifyP256(digest, r, s, x, y)) {
      revert InvalidSignature();
    }

    users[keyHash] = User({username: username, x: x, y: y, balance: INITIAL_BALANCE, nonce: 0, createdAt: block.timestamp, exists: true});

    userKeys.push(keyHash);
  }

  function transfer(
    bytes32 senderX,
    bytes32 senderY,
    bytes32 recipientX,
    bytes32 recipientY,
    uint256 amount,
    uint256 nonce,
    uint256 deadline,
    bytes32 r,
    bytes32 s
  ) external {
    // forge-lint: disable-next-line(block-timestamp)
    if (block.timestamp > deadline) {
      revert TransactionExpired();
    }

    if (amount == 0) {
      revert InvalidAmount();
    }

    bytes32 senderHash = _publicKeyHash(senderX, senderY);
    bytes32 recipientHash = _publicKeyHash(recipientX, recipientY);

    User storage sender = users[senderHash];
    User storage recipient = users[recipientHash];

    if (!sender.exists || !recipient.exists) {
      revert UserNotFound();
    }

    if (sender.nonce != nonce) {
      revert InvalidNonce();
    }

    if (sender.balance < amount) {
      revert InsufficientBalance();
    }

    bytes32 digest = sha256(
      abi.encode(
        "PASSKEY_TRANSFER",
        address(this),
        block.chainid,
        senderX,
        senderY,
        recipientX,
        recipientY,
        amount,
        nonce,
        deadline
      )
    );

    emit FundsTransferred(senderHash, recipientHash, amount, nonce);

    if (!_verifyP256(digest, r, s, senderX, senderY)) {
      revert InvalidSignature();
    }

    sender.nonce = nonce + 1;
    sender.balance -= amount;
    recipient.balance += amount;
  }

  function getUser(bytes32 x, bytes32 y) external view returns (bool exists, uint256 balance, uint256 nonce) {
    bytes32 keyHash = _publicKeyHash(x, y);
    User memory user = users[keyHash];

    return (user.exists, user.balance, user.nonce);
  }

  function getBalance(bytes32 x, bytes32 y) external view returns (uint256) {
    bytes32 keyHash = _publicKeyHash(x, y);
    User memory user = users[keyHash];

    if (!user.exists) {
      revert UserNotFound();
    }

    return user.balance;
  }

  function getUsers()
    external
    view
    returns (
      bytes32[] memory publicKeyHashes,
      bytes32[] memory xs,
      bytes32[] memory ys,
      string[] memory usernames,
      uint256[] memory balances,
      uint256[] memory nonces,
      uint256[] memory createdAts
    )
  {
    uint256 length = userKeys.length;

    publicKeyHashes = new bytes32[](length);
    xs = new bytes32[](length);
    ys = new bytes32[](length);
    usernames = new string[](length);
    balances = new uint256[](length);
    nonces = new uint256[](length);
    createdAts = new uint256[](length);

    for (uint256 i = 0; i < length; i++) {
      bytes32 keyHash = userKeys[i];
      User memory user = users[keyHash];

      publicKeyHashes[i] = keyHash;
      xs[i] = user.x;
      ys[i] = user.y;
      usernames[i] = user.username;
      balances[i] = user.balance;
      nonces[i] = user.nonce;
      createdAts[i] = user.createdAt;
    }
  }

  function userCount() external view returns (uint256) {
    return userKeys.length;
  }

  function publicKeyHash(bytes32 x, bytes32 y) external pure returns (bytes32) {
    return _publicKeyHash(x, y);
  }

  function _publicKeyHash(bytes32 x, bytes32 y) internal pure returns (bytes32) {
    return keccak256(abi.encode(x, y));
  }

  function _verifyP256(bytes32 digest, bytes32 r, bytes32 s, bytes32 x, bytes32 y) internal view returns (bool valid) {
    bytes memory input = abi.encodePacked(digest, r, s, x, y);

    uint256 result = 0;

    assembly {
      // Request the 32-byte result directly. Some local EVMs do not expose
      // RIP-7212 and return success with no returndata; copying 32 bytes from
      // that empty buffer causes an `OutOfOffset` revert.
      let success := staticcall(gas(), 0x100, add(input, 32), 160, 0, 32)

      if success {
        result := mload(0)
      }
    }

    return result == 1;
  }
}
