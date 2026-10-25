//! Orientim Guard (proof of concept).
//!
//! The owner's tokens stay in the owner's own token accounts. The owner approves this program's
//! authority PDA as their delegate for a budget, and writes the rules on chain: which agent, which
//! verifiers (Orientim's co-signing key), which swap programs, which mints, how much per swap and per
//! day. An agent then trades by sending one transaction of this shape:
//!
//! ```text
//! [ComputeBudget ...]
//! Guard::Pull     agent and a verifier sign; the exact amount moves to the agent's hopper, the fee
//!                 to the treasury; the output account's balance is recorded
//! [the swap: only programs the owner allowed, and creating token accounts]
//! Guard::Settle   last instruction: the output grew by at least min_out, anything left in the hopper
//!                 goes back to the owner
//! ```
//!
//! Without a verifier's signature nothing moves (two, Orientim's and the owner's own, when the owner
//! sets the policy's threshold to 2); without the owner's rules nothing moves either. The
//! authority PDA signs exactly one thing, a `TransferChecked` of the approved amount to the hopper (and
//! of the fee to the treasury): its signature never reaches the swap program.
//!
//! Design and rules (I1–I9): docs/GUARD.md.

#![deny(unsafe_code)]
#![allow(deprecated)] // solana-program 4 re-exports the sysvar helpers under deprecated paths

use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{get_stack_height, AccountMeta, Instruction, TRANSACTION_LEVEL_STACK_HEIGHT},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::{
        instructions::{load_current_index_checked, load_instruction_at_checked},
        Sysvar,
    },
};

pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM: Pubkey = pubkey!("11111111111111111111111111111111");
pub const COMPUTE_BUDGET_PROGRAM: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");

/// Orientim's treasury wallet. A placeholder for the proof of concept: no one holds its key. The fee
/// goes to its associated token account for the input mint.
pub const TREASURY: Pubkey = pubkey!("syQjBykbfYCGSSeLZSyEb2vJ2XMbHDfXoKsrVwCsDDq");
/// Orientim's fee on the input, in basis points (0.25%), fixed in the program.
pub const FEE_BPS: u64 = 25;

pub const POLICY_SEED: &[u8] = b"policy";
pub const GRANT_SEED: &[u8] = b"grant";
pub const AUTHORITY_SEED: &[u8] = b"auth";

pub const MAX_VERIFIERS: usize = 2;
pub const MAX_PROGRAMS: usize = 4;
pub const MAX_LIMITS: usize = 4;
pub const MAX_OUTPUTS: usize = 4;
pub const MAX_FEEDS: usize = 8;

/// Pyth's Solana receiver program, owner of every `PriceUpdateV2` account.
pub const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const PRICE_UPDATE_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
/// A price older than this (seconds) is refused.
pub const MAX_PRICE_AGE: i64 = 60;
/// A price whose confidence interval is wider than 1/this of the price (2%) is refused.
const MAX_CONF_DIVISOR: u128 = 50;
/// The owner may allow at most this much below the oracle's price (50%).
const MAX_SLIPPAGE_BPS: u16 = 5_000;

const SECONDS_PER_DAY: i64 = 86_400;

entrypoint!(process_instruction);

// ---------------------------------------------------------------- errors

/// Custom error codes (`ProgramError::Custom`). The numbers are part of the interface: never reuse one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum GuardError {
    NotOwner = 1,
    BadPolicy = 2,
    BadGrant = 3,
    Paused = 4,
    AgentNotActive = 5,
    UnknownVerifier = 6,
    MustBeTopLevel = 7,
    BadShape = 8,
    ProgramNotAllowed = 9,
    MintNotAllowed = 10,
    OverSwapLimit = 11,
    OverDailyLimit = 12,
    BadTokenAccount = 13,
    NotDelegated = 14,
    BadTreasury = 15,
    UnsafeMint = 16,
    SwapInProgress = 17,
    NoSwapInProgress = 18,
    MismatchedSettle = 19,
    BelowMinimum = 20,
    HopperShort = 21,
    BadAmount = 22,
    Math = 23,
    SecondVerifierMissing = 24,
    BadOracle = 25,
    StalePrice = 26,
    PriceUncertain = 27,
    BelowOracle = 28,
    Unpriced = 29,
}

impl From<GuardError> for ProgramError {
    fn from(e: GuardError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

fn fail(e: GuardError, why: &str) -> ProgramError {
    msg!("guard: {}", why);
    e.into()
}

// ---------------------------------------------------------------- byte helpers

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], ProgramError> {
        let end = self.at.checked_add(n).ok_or(ProgramError::InvalidInstructionData)?;
        let out = self.data.get(self.at..end).ok_or(ProgramError::InvalidInstructionData)?;
        self.at = end;
        Ok(out)
    }
    fn u8(&mut self) -> Result<u8, ProgramError> {
        Ok(self.take(1)?[0])
    }
    fn u64(&mut self) -> Result<u64, ProgramError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> Result<i64, ProgramError> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn u16(&mut self) -> Result<u16, ProgramError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32, ProgramError> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn key(&mut self) -> Result<Pubkey, ProgramError> {
        Ok(Pubkey::new_from_array(self.take(32)?.try_into().unwrap()))
    }
    fn done(&self) -> Result<(), ProgramError> {
        if self.at == self.data.len() { Ok(()) } else { Err(ProgramError::InvalidInstructionData) }
    }
}

struct Writer<'a> {
    data: &'a mut [u8],
    at: usize,
}

impl<'a> Writer<'a> {
    fn put(&mut self, bytes: &[u8]) {
        self.data[self.at..self.at + bytes.len()].copy_from_slice(bytes);
        self.at += bytes.len();
    }
    fn u8(&mut self, v: u8) {
        self.put(&[v]);
    }
    fn u64(&mut self, v: u64) {
        self.put(&v.to_le_bytes());
    }
    fn i64(&mut self, v: i64) {
        self.put(&v.to_le_bytes());
    }
    fn u16(&mut self, v: u16) {
        self.put(&v.to_le_bytes());
    }
    fn key(&mut self, k: &Pubkey) {
        self.put(k.as_ref());
    }
}

// ---------------------------------------------------------------- state

/// What `Pull` leaves for `Settle` in the same transaction. Never outlives a transaction: `Pull`
/// requires a `Settle` at the end, and a failed transaction rolls everything back.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Pending {
    pub active: bool,
    pub agent: Pubkey,
    pub owner_in: Pubkey,
    pub hopper: Pubkey,
    pub hopper_before: u64,
    pub owner_out: Pubkey,
    pub out_before: u64,
    pub min_out: u64,
    pub mint_in: Pubkey,
    pub token_program_in: Pubkey,
    /// The oracle check for `Settle`: 0 when the grant sets none (or allows this pair unpriced).
    pub slippage_bps: u16,
    pub amount: u64,
    pub decimals_in: u8,
    pub decimals_out: u8,
    pub feed_in: Pubkey,
    pub feed_out: Pubkey,
}

const PENDING_SIZE: usize = 1 + 32 * 6 + 8 * 3 + 2 + 8 + 2 + 32 * 2;

/// The owner's rules. PDA `["policy", owner]`.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Policy {
    pub bump: u8,
    pub authority_bump: u8,
    pub paused: bool,
    /// How many of the verifiers must sign each pull: 1 (Orientim) or 2 (Orientim and the owner's own).
    pub threshold: u8,
    pub owner: Pubkey,
    pub verifiers: [Pubkey; MAX_VERIFIERS],
    pub programs: [Pubkey; MAX_PROGRAMS],
    pub pending: Pending,
}

const POLICY_TAG: u8 = 1;
pub const POLICY_SIZE: usize = 1 + 4 + 32 + 32 * MAX_VERIFIERS + 32 * MAX_PROGRAMS + PENDING_SIZE;

impl Policy {
    fn read(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != POLICY_SIZE || data[0] != POLICY_TAG {
            return Err(fail(GuardError::BadPolicy, "not a policy account"));
        }
        let mut r = Reader { data, at: 1 };
        let mut p = Policy { bump: r.u8()?, authority_bump: r.u8()?, paused: r.u8()? != 0, threshold: r.u8()?, owner: r.key()?, ..Default::default() };
        for v in p.verifiers.iter_mut() {
            *v = r.key()?;
        }
        for v in p.programs.iter_mut() {
            *v = r.key()?;
        }
        p.pending = Pending {
            active: r.u8()? != 0,
            agent: r.key()?,
            owner_in: r.key()?,
            hopper: r.key()?,
            hopper_before: r.u64()?,
            owner_out: r.key()?,
            out_before: r.u64()?,
            min_out: r.u64()?,
            mint_in: r.key()?,
            token_program_in: r.key()?,
            slippage_bps: r.u16()?,
            amount: r.u64()?,
            decimals_in: r.u8()?,
            decimals_out: r.u8()?,
            feed_in: r.key()?,
            feed_out: r.key()?,
        };
        Ok(p)
    }

    fn write(&self, data: &mut [u8]) {
        let mut w = Writer { data, at: 0 };
        w.u8(POLICY_TAG);
        w.u8(self.bump);
        w.u8(self.authority_bump);
        w.u8(self.paused as u8);
        w.u8(self.threshold);
        w.key(&self.owner);
        for v in &self.verifiers {
            w.key(v);
        }
        for v in &self.programs {
            w.key(v);
        }
        let q = &self.pending;
        w.u8(q.active as u8);
        w.key(&q.agent);
        w.key(&q.owner_in);
        w.key(&q.hopper);
        w.u64(q.hopper_before);
        w.key(&q.owner_out);
        w.u64(q.out_before);
        w.u64(q.min_out);
        w.key(&q.mint_in);
        w.key(&q.token_program_in);
        w.u16(q.slippage_bps);
        w.u64(q.amount);
        w.u8(q.decimals_in);
        w.u8(q.decimals_out);
        w.key(&q.feed_in);
        w.key(&q.feed_out);
    }
}

/// One input mint the agent may spend, with its limits and today's count.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Limit {
    pub mint: Pubkey,
    pub max_per_swap: u64,
    pub max_per_day: u64,
    pub used_today: u64,
    pub day: i64,
}

pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_PAUSED: u8 = 1;
pub const STATUS_REVOKED: u8 = 2;

/// One agent's permission. PDA `["grant", owner, agent]`.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Grant {
    pub bump: u8,
    pub status: u8,
    pub expires_at: i64,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub limits: [Limit; MAX_LIMITS],
    pub outputs: [Pubkey; MAX_OUTPUTS],
    /// The least the output may be worth, by Pyth's prices, below the input's worth (bps); 0: no check.
    pub max_slippage_bps: u16,
    /// With a slippage set: whether a pair without a feed may still swap (unchecked) or is refused.
    pub allow_unpriced: bool,
    /// The Pyth feed of each priced mint.
    pub feeds: [Feed; MAX_FEEDS],
}

/// A mint and its Pyth price feed id (the feed's 32 bytes, held as a `Pubkey`).
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Feed {
    pub mint: Pubkey,
    pub feed: Pubkey,
}

const GRANT_TAG: u8 = 2;
pub const GRANT_SIZE: usize = 1 + 2 + 8 + 32 * 2 + (32 + 8 * 4) * MAX_LIMITS + 32 * MAX_OUTPUTS + 2 + 1 + 64 * MAX_FEEDS;

impl Grant {
    fn read(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != GRANT_SIZE || data[0] != GRANT_TAG {
            return Err(fail(GuardError::BadGrant, "not a grant account"));
        }
        let mut r = Reader { data, at: 1 };
        let mut g = Grant { bump: r.u8()?, status: r.u8()?, expires_at: r.i64()?, owner: r.key()?, agent: r.key()?, ..Default::default() };
        for l in g.limits.iter_mut() {
            *l = Limit { mint: r.key()?, max_per_swap: r.u64()?, max_per_day: r.u64()?, used_today: r.u64()?, day: r.i64()? };
        }
        for o in g.outputs.iter_mut() {
            *o = r.key()?;
        }
        g.max_slippage_bps = r.u16()?;
        g.allow_unpriced = r.u8()? != 0;
        for f in g.feeds.iter_mut() {
            *f = Feed { mint: r.key()?, feed: r.key()? };
        }
        Ok(g)
    }

    fn write(&self, data: &mut [u8]) {
        let mut w = Writer { data, at: 0 };
        w.u8(GRANT_TAG);
        w.u8(self.bump);
        w.u8(self.status);
        w.i64(self.expires_at);
        w.key(&self.owner);
        w.key(&self.agent);
        for l in &self.limits {
            w.key(&l.mint);
            w.u64(l.max_per_swap);
            w.u64(l.max_per_day);
            w.u64(l.used_today);
            w.i64(l.day);
        }
        for o in &self.outputs {
            w.key(o);
        }
        w.u16(self.max_slippage_bps);
        w.u8(self.allow_unpriced as u8);
        for f in &self.feeds {
            w.key(&f.mint);
            w.key(&f.feed);
        }
    }
}

// ---------------------------------------------------------------- Pyth prices

/// The fields of a Pyth `PriceUpdateV2` this program reads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Price {
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
}

/// A fully verified, fresh and tight price of `feed`, from an account Pyth's receiver owns.
fn read_price(info: &AccountInfo, feed: &Pubkey, now: i64) -> Result<Price, ProgramError> {
    if *info.owner != PYTH_RECEIVER {
        return Err(fail(GuardError::BadOracle, "price account not owned by Pyth's receiver"));
    }
    let data = info.try_borrow_data()?;
    parse_price(&data, feed, now)
}

fn parse_price(data: &[u8], feed: &Pubkey, now: i64) -> Result<Price, ProgramError> {
    let bad = || fail(GuardError::BadOracle, "not a verified price update of this feed");
    if data.get(..8) != Some(&PRICE_UPDATE_DISCRIMINATOR[..]) {
        return Err(bad());
    }
    // discriminator, write authority, then the verification level: 1 = Full (one byte); Partial is refused.
    let mut r = Reader { data, at: 8 + 32 };
    if r.u8().map_err(|_| bad())? != 1 {
        return Err(bad());
    }
    if r.key().map_err(|_| bad())? != *feed {
        return Err(bad());
    }
    let p = Price { price: r.i64()?, conf: r.u64()?, expo: r.i32()?, publish_time: r.i64()? };
    if p.price <= 0 {
        return Err(bad());
    }
    if now.saturating_sub(p.publish_time) > MAX_PRICE_AGE {
        return Err(fail(GuardError::StalePrice, "the price is older than a minute"));
    }
    if (p.conf as u128) * MAX_CONF_DIVISOR > p.price as u128 {
        return Err(fail(GuardError::PriceUncertain, "the price's confidence interval is too wide"));
    }
    Ok(p)
}

fn pow10(e: u32) -> Result<u128, ProgramError> {
    10u128.checked_pow(e).ok_or_else(|| GuardError::Math.into())
}

/// The least output (in its base units) that `amount` of the input is worth by these prices, less
/// `slippage_bps`: amount × price_in × 10^(expo_in − expo_out + decimals_out − decimals_in) / price_out.
fn oracle_floor(amount: u64, decimals_in: u8, decimals_out: u8, p_in: &Price, p_out: &Price, slippage_bps: u16) -> Result<u128, ProgramError> {
    let k = (p_in.expo as i64) - (p_out.expo as i64) + (decimals_out as i64) - (decimals_in as i64);
    let num = (amount as u128).checked_mul(p_in.price as u128).ok_or(GuardError::Math)?;
    let expected = if k >= 0 {
        num.checked_mul(pow10(k as u32)?).ok_or(GuardError::Math)? / p_out.price as u128
    } else {
        num / (p_out.price as u128).checked_mul(pow10((-k) as u32)?).ok_or(GuardError::Math)?
    };
    Ok(expected.checked_mul(10_000 - slippage_bps as u128).ok_or(GuardError::Math)? / 10_000)
}

// ---------------------------------------------------------------- token accounts and mints

/// The fields of an SPL Token / Token-2022 account this program reads (the base 165 bytes).
pub struct TokenAccount {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub delegate: Option<Pubkey>,
    pub delegated_amount: u64,
}

fn is_token_program(k: &Pubkey) -> bool {
    *k == TOKEN_PROGRAM || *k == TOKEN_2022_PROGRAM
}

fn token_account(info: &AccountInfo) -> Result<TokenAccount, ProgramError> {
    if !is_token_program(info.owner) {
        return Err(fail(GuardError::BadTokenAccount, "token account not owned by a token program"));
    }
    let data = info.try_borrow_data()?;
    // 165 bytes for SPL Token; Token-2022 adds the account type (2) at 165, then extensions.
    if data.len() < 165 || (data.len() > 165 && data[165] != 2) || data[108] != 1 {
        return Err(fail(GuardError::BadTokenAccount, "not an initialized token account"));
    }
    let key = |at: usize| Pubkey::new_from_array(data[at..at + 32].try_into().unwrap());
    let u64_at = |at: usize| u64::from_le_bytes(data[at..at + 8].try_into().unwrap());
    let delegate = if data[72] == 1 { Some(key(76)) } else { None };
    Ok(TokenAccount { mint: key(0), owner: key(32), amount: u64_at(64), delegate, delegated_amount: u64_at(121) })
}

fn amount_of(info: &AccountInfo) -> Result<u64, ProgramError> {
    Ok(token_account(info)?.amount)
}

/// Token-2022 mint extensions this program accepts (rule I9). Everything else is refused, including
/// a permanent delegate, non-transferable, pausable, confidential transfers and interest or scaled
/// amounts: stricter than the verifier's R7 on purpose, since this rule cannot be patched later.
fn extension_allowed(kind: u16, value: &[u8]) -> bool {
    match kind {
        1 => true,                           // TransferFeeConfig: the fee is withheld from what arrives; deltas are measured
        3 => true,                           // MintCloseAuthority
        6 => true,                           // DefaultAccountState
        14 => value.len() >= 64 && value[32..64].iter().all(|b| *b == 0), // TransferHook, only with no program
        18..=23 => true,                     // metadata and group pointers and data
        _ => false,
    }
}

/// Returns the mint's decimals after checking it belongs to `token_program` and carries only allowed
/// extensions.
fn checked_mint(info: &AccountInfo, token_program: &Pubkey) -> Result<u8, ProgramError> {
    if info.owner != token_program {
        return Err(fail(GuardError::UnsafeMint, "mint not owned by the token program"));
    }
    let data = info.try_borrow_data()?;
    if data.len() < 82 || data[45] != 1 {
        return Err(fail(GuardError::UnsafeMint, "not an initialized mint"));
    }
    let decimals = data[44];
    if data.len() > 82 {
        if *token_program != TOKEN_2022_PROGRAM || data.len() < 166 || data[165] != 1 {
            return Err(fail(GuardError::UnsafeMint, "unexpected mint layout"));
        }
        let mut at = 166;
        while at + 4 <= data.len() {
            let kind = u16::from_le_bytes([data[at], data[at + 1]]);
            let len = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
            if kind == 0 {
                break; // Uninitialized: the rest is padding
            }
            let value = data.get(at + 4..at + 4 + len).ok_or_else(|| fail(GuardError::UnsafeMint, "truncated extension"))?;
            if !extension_allowed(kind, value) {
                msg!("guard: mint extension {} refused", kind);
                return Err(GuardError::UnsafeMint.into());
            }
            at += 4 + len;
        }
    }
    Ok(decimals)
}

fn transfer_checked(token_program: &Pubkey, source: &Pubkey, mint: &Pubkey, destination: &Pubkey, authority: &Pubkey, amount: u64, decimals: u8) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(12);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

fn ata_of(wallet: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[wallet.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

// ---------------------------------------------------------------- instructions

pub const IX_INIT_POLICY: u8 = 0;
pub const IX_UPDATE_POLICY: u8 = 1;
pub const IX_SET_GRANT: u8 = 2;
pub const IX_PULL: u8 = 3;
pub const IX_SETTLE: u8 = 4;

fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match *tag {
        IX_INIT_POLICY => init_policy(program_id, accounts, rest),
        IX_UPDATE_POLICY => update_policy(program_id, accounts, rest),
        IX_SET_GRANT => set_grant(program_id, accounts, rest),
        IX_PULL => pull(program_id, accounts, rest),
        IX_SETTLE => settle(program_id, accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn account<'a, 'b>(accounts: &'a [AccountInfo<'b>], i: usize) -> Result<&'a AccountInfo<'b>, ProgramError> {
    accounts.get(i).ok_or(ProgramError::NotEnoughAccountKeys)
}

fn require_signer(info: &AccountInfo) -> ProgramResult {
    if info.is_signer { Ok(()) } else { Err(ProgramError::MissingRequiredSignature) }
}

fn read_keys<const N: usize>(r: &mut Reader) -> Result<[Pubkey; N], ProgramError> {
    let mut out = [Pubkey::default(); N];
    for k in out.iter_mut() {
        *k = r.key()?;
    }
    Ok(out)
}

/// The swap programs an owner may allow: never this program, a token program or the system program.
/// 1 or 2 signatures, and never more than the distinct verifiers named.
fn check_threshold(verifiers: &[Pubkey; MAX_VERIFIERS], threshold: u8) -> ProgramResult {
    let named = verifiers.iter().enumerate().filter(|(i, v)| **v != Pubkey::default() && !verifiers[..*i].contains(v)).count();
    if threshold == 0 || threshold as usize > MAX_VERIFIERS || threshold as usize > named {
        return Err(fail(GuardError::BadPolicy, "the threshold must be 1 or 2, and at most the distinct verifiers named"));
    }
    Ok(())
}

fn check_programs(program_id: &Pubkey, programs: &[Pubkey]) -> ProgramResult {
    for p in programs {
        if *p == *program_id || is_token_program(p) || *p == SYSTEM_PROGRAM || *p == ATA_PROGRAM {
            return Err(fail(GuardError::BadPolicy, "this program cannot be a swap program"));
        }
    }
    Ok(())
}

fn create_pda<'a>(payer: &AccountInfo<'a>, target: &AccountInfo<'a>, system: &AccountInfo<'a>, owner: &Pubkey, space: usize, seeds: &[&[u8]]) -> ProgramResult {
    if *system.key != SYSTEM_PROGRAM {
        return Err(ProgramError::IncorrectProgramId);
    }
    if target.lamports() != 0 || !target.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let lamports = Rent::get()?.minimum_balance(space);
    let mut data = Vec::with_capacity(52);
    data.extend_from_slice(&0u32.to_le_bytes()); // CreateAccount
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&(space as u64).to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    let ix = Instruction {
        program_id: SYSTEM_PROGRAM,
        accounts: vec![AccountMeta::new(*payer.key, true), AccountMeta::new(*target.key, true)],
        data,
    };
    invoke_signed(&ix, &[payer.clone(), target.clone(), system.clone()], &[seeds])
}

/// `InitPolicy`: [owner (signer, writable), policy (writable), system program]
/// data: verifiers [32; 2], programs [32; 4], threshold u8
fn init_policy(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let owner = account(accounts, 0)?;
    let policy_info = account(accounts, 1)?;
    let system = account(accounts, 2)?;
    require_signer(owner)?;
    let mut r = Reader { data, at: 0 };
    let verifiers = read_keys::<MAX_VERIFIERS>(&mut r)?;
    let programs = read_keys::<MAX_PROGRAMS>(&mut r)?;
    let threshold = r.u8()?;
    r.done()?;
    check_threshold(&verifiers, threshold)?;
    check_programs(program_id, &programs.iter().copied().filter(|p| *p != Pubkey::default()).collect::<Vec<_>>())?;

    let (expected, bump) = Pubkey::find_program_address(&[POLICY_SEED, owner.key.as_ref()], program_id);
    if expected != *policy_info.key {
        return Err(fail(GuardError::BadPolicy, "policy address"));
    }
    let (_, authority_bump) = Pubkey::find_program_address(&[AUTHORITY_SEED, owner.key.as_ref()], program_id);
    create_pda(owner, policy_info, system, program_id, POLICY_SIZE, &[POLICY_SEED, owner.key.as_ref(), &[bump]])?;
    let policy = Policy { bump, authority_bump, paused: false, threshold, owner: *owner.key, verifiers, programs, pending: Pending::default() };
    policy.write(&mut policy_info.try_borrow_mut_data()?);
    Ok(())
}

fn load_policy(program_id: &Pubkey, info: &AccountInfo) -> Result<Policy, ProgramError> {
    if info.owner != program_id {
        return Err(fail(GuardError::BadPolicy, "policy not owned by this program"));
    }
    let policy = Policy::read(&info.try_borrow_data()?)?;
    let expected = Pubkey::create_program_address(&[POLICY_SEED, policy.owner.as_ref(), &[policy.bump]], program_id)
        .map_err(|_| fail(GuardError::BadPolicy, "policy address"))?;
    if expected != *info.key {
        return Err(fail(GuardError::BadPolicy, "policy address"));
    }
    Ok(policy)
}

/// `UpdatePolicy`: [owner (signer), policy (writable)]
/// data: paused u8, verifiers [32; 2], programs [32; 4], threshold u8
fn update_policy(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let owner = account(accounts, 0)?;
    let policy_info = account(accounts, 1)?;
    require_signer(owner)?;
    let mut policy = load_policy(program_id, policy_info)?;
    if policy.owner != *owner.key {
        return Err(fail(GuardError::NotOwner, "only the owner changes the policy"));
    }
    let mut r = Reader { data, at: 0 };
    policy.paused = r.u8()? != 0;
    policy.verifiers = read_keys::<MAX_VERIFIERS>(&mut r)?;
    policy.programs = read_keys::<MAX_PROGRAMS>(&mut r)?;
    policy.threshold = r.u8()?;
    r.done()?;
    check_threshold(&policy.verifiers, policy.threshold)?;
    check_programs(program_id, &policy.programs.iter().copied().filter(|p| *p != Pubkey::default()).collect::<Vec<_>>())?;
    policy.write(&mut policy_info.try_borrow_mut_data()?);
    Ok(())
}

/// `SetGrant`: [owner (signer, writable), policy, grant (writable), system program]
/// data: agent [32], status u8, expires_at i64, 4 × (mint [32], max_per_swap u64, max_per_day u64), outputs [32; 4],
/// max_slippage_bps u16, allow_unpriced u8, 8 × (mint [32], Pyth feed id [32])
fn set_grant(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let owner = account(accounts, 0)?;
    let policy_info = account(accounts, 1)?;
    let grant_info = account(accounts, 2)?;
    let system = account(accounts, 3)?;
    require_signer(owner)?;
    let policy = load_policy(program_id, policy_info)?;
    if policy.owner != *owner.key {
        return Err(fail(GuardError::NotOwner, "only the owner grants"));
    }
    let mut r = Reader { data, at: 0 };
    let agent = r.key()?;
    let status = r.u8()?;
    let expires_at = r.i64()?;
    if status > STATUS_REVOKED {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut limits = [Limit::default(); MAX_LIMITS];
    for l in limits.iter_mut() {
        *l = Limit { mint: r.key()?, max_per_swap: r.u64()?, max_per_day: r.u64()?, used_today: 0, day: 0 };
    }
    let outputs = read_keys::<MAX_OUTPUTS>(&mut r)?;
    let max_slippage_bps = r.u16()?;
    let allow_unpriced = r.u8()? != 0;
    let mut feeds = [Feed::default(); MAX_FEEDS];
    for f in feeds.iter_mut() {
        *f = Feed { mint: r.key()?, feed: r.key()? };
    }
    r.done()?;
    if max_slippage_bps > MAX_SLIPPAGE_BPS {
        return Err(fail(GuardError::BadGrant, "slippage above 50%"));
    }

    let (expected, bump) = Pubkey::find_program_address(&[GRANT_SEED, owner.key.as_ref(), agent.as_ref()], program_id);
    if expected != *grant_info.key {
        return Err(fail(GuardError::BadGrant, "grant address"));
    }
    if grant_info.data_is_empty() {
        create_pda(owner, grant_info, system, program_id, GRANT_SIZE, &[GRANT_SEED, owner.key.as_ref(), agent.as_ref(), &[bump]])?;
    } else {
        if grant_info.owner != program_id {
            return Err(fail(GuardError::BadGrant, "grant not owned by this program"));
        }
        // Keep today's count for a mint that stays, so that changing the rules never resets it.
        let old = Grant::read(&grant_info.try_borrow_data()?)?;
        for l in limits.iter_mut() {
            if let Some(o) = old.limits.iter().find(|o| o.mint == l.mint && o.mint != Pubkey::default()) {
                l.used_today = o.used_today;
                l.day = o.day;
            }
        }
    }
    let grant = Grant { bump, status, expires_at, owner: *owner.key, agent, limits, outputs, max_slippage_bps, allow_unpriced, feeds };
    grant.write(&mut grant_info.try_borrow_mut_data()?);
    Ok(())
}

/// Rule I3: the transaction is `[ComputeBudget*] Pull (allowed programs | ATA | ComputeBudget)* Settle`,
/// with this Pull at `current` and the Settle, naming the same policy, last.
fn check_shape(program_id: &Pubkey, sysvar: &AccountInfo, policy_key: &Pubkey, allowed: &[Pubkey]) -> ProgramResult {
    let current = load_current_index_checked(sysvar)? as usize;
    for i in 0..current {
        if load_instruction_at_checked(i, sysvar)?.program_id != COMPUTE_BUDGET_PROGRAM {
            return Err(fail(GuardError::BadShape, "only compute budget may come before pull"));
        }
    }
    // The count is the first u16 of the sysvar's data.
    let count = {
        let d = sysvar.try_borrow_data()?;
        u16::from_le_bytes([d[0], d[1]]) as usize
    };
    if count < current + 2 {
        return Err(fail(GuardError::BadShape, "no settle after pull"));
    }
    let last = load_instruction_at_checked(count - 1, sysvar)?;
    if last.program_id != *program_id || last.data.first() != Some(&IX_SETTLE) || last.accounts.get(1).map(|m| m.pubkey) != Some(*policy_key) {
        return Err(fail(GuardError::BadShape, "the last instruction must be settle for this policy"));
    }
    for i in current + 1..count - 1 {
        let p = load_instruction_at_checked(i, sysvar)?.program_id;
        if !(allowed.contains(&p) || p == ATA_PROGRAM || p == COMPUTE_BUDGET_PROGRAM) {
            msg!("guard: program {} not allowed between pull and settle", p);
            return Err(GuardError::ProgramNotAllowed.into());
        }
    }
    Ok(())
}

/// `Pull`:
/// 0 agent (signer), 1 verifier (signer), 2 policy (writable), 3 grant (writable), 4 authority,
/// 5 owner_in (writable), 6 mint_in, 7 hopper (writable), 8 treasury_in (writable), 9 owner_out,
/// 10 mint_out, 11 token program of the input, 12 token program of the output, 13 instructions sysvar,
/// 14 the second verifier (signer; only when the policy's threshold is 2)
/// data: amount u64, min_out u64
fn pull(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if get_stack_height() != TRANSACTION_LEVEL_STACK_HEIGHT {
        return Err(fail(GuardError::MustBeTopLevel, "pull must be a top-level instruction"));
    }
    let agent = account(accounts, 0)?;
    let verifier = account(accounts, 1)?;
    let policy_info = account(accounts, 2)?;
    let grant_info = account(accounts, 3)?;
    let authority = account(accounts, 4)?;
    let owner_in = account(accounts, 5)?;
    let mint_in = account(accounts, 6)?;
    let hopper = account(accounts, 7)?;
    let treasury_in = account(accounts, 8)?;
    let owner_out = account(accounts, 9)?;
    let mint_out = account(accounts, 10)?;
    let token_in = account(accounts, 11)?;
    let token_out = account(accounts, 12)?;
    let sysvar = account(accounts, 13)?;

    let mut r = Reader { data, at: 0 };
    let amount = r.u64()?;
    let min_out = r.u64()?;
    r.done()?;

    // I1: who signs, and whether they may.
    require_signer(agent)?;
    require_signer(verifier)?;
    let mut policy = load_policy(program_id, policy_info)?;
    if policy.paused {
        return Err(fail(GuardError::Paused, "the owner paused this policy"));
    }
    if policy.pending.active {
        return Err(fail(GuardError::SwapInProgress, "a swap is already in progress"));
    }
    if *verifier.key == Pubkey::default() || !policy.verifiers.contains(verifier.key) {
        return Err(fail(GuardError::UnknownVerifier, "the verifier is not in the owner's policy"));
    }
    if policy.threshold >= 2 {
        let second = accounts.get(14).ok_or_else(|| fail(GuardError::SecondVerifierMissing, "the policy needs a second verifier"))?;
        if !second.is_signer || second.key == verifier.key || *second.key == Pubkey::default() || !policy.verifiers.contains(second.key) {
            return Err(fail(GuardError::SecondVerifierMissing, "the policy needs a second, different verifier to sign"));
        }
    }
    if grant_info.owner != program_id {
        return Err(fail(GuardError::BadGrant, "grant not owned by this program"));
    }
    let mut grant = Grant::read(&grant_info.try_borrow_data()?)?;
    let expected_grant = Pubkey::create_program_address(&[GRANT_SEED, policy.owner.as_ref(), agent.key.as_ref(), &[grant.bump]], program_id)
        .map_err(|_| fail(GuardError::BadGrant, "grant address"))?;
    if expected_grant != *grant_info.key || grant.owner != policy.owner || grant.agent != *agent.key {
        return Err(fail(GuardError::BadGrant, "this grant is not the agent's"));
    }
    let now = Clock::get()?.unix_timestamp;
    if grant.status != STATUS_ACTIVE || (grant.expires_at != 0 && now >= grant.expires_at) {
        return Err(fail(GuardError::AgentNotActive, "the agent is paused, revoked or expired"));
    }

    // I3: the transaction's shape.
    let allowed: Vec<Pubkey> = policy.programs.iter().copied().filter(|p| *p != Pubkey::default()).collect();
    check_shape(program_id, sysvar, policy_info.key, &allowed)?;

    // I2 and I9: the accounts and mints.
    let authority_key = Pubkey::create_program_address(&[AUTHORITY_SEED, policy.owner.as_ref(), &[policy.authority_bump]], program_id)
        .map_err(|_| fail(GuardError::BadPolicy, "authority address"))?;
    if *authority.key != authority_key {
        return Err(fail(GuardError::BadPolicy, "authority address"));
    }
    if !is_token_program(token_in.key) || !is_token_program(token_out.key) {
        return Err(ProgramError::IncorrectProgramId);
    }
    if owner_in.owner != token_in.key || hopper.owner != token_in.key || owner_out.owner != token_out.key {
        return Err(fail(GuardError::BadTokenAccount, "token account of another token program"));
    }
    if mint_in.key == mint_out.key {
        return Err(fail(GuardError::MintNotAllowed, "input and output mints are the same"));
    }
    let decimals_in = checked_mint(mint_in, token_in.key)?;
    let decimals_out = checked_mint(mint_out, token_out.key)?;

    let src = token_account(owner_in)?;
    if src.owner != policy.owner || src.mint != *mint_in.key {
        return Err(fail(GuardError::BadTokenAccount, "the input account is not the owner's"));
    }
    if src.delegate != Some(authority_key) {
        return Err(fail(GuardError::NotDelegated, "the owner has not approved this program for the input"));
    }
    let hop = token_account(hopper)?;
    if hop.owner != *agent.key || hop.mint != *mint_in.key || hopper.key == owner_in.key {
        return Err(fail(GuardError::BadTokenAccount, "the hopper must be the agent's account for the input mint"));
    }
    let out = token_account(owner_out)?;
    if out.owner != policy.owner || out.mint != *mint_out.key {
        return Err(fail(GuardError::BadTokenAccount, "the output account is not the owner's"));
    }
    if *treasury_in.key != ata_of(&TREASURY, mint_in.key, token_in.key) {
        return Err(fail(GuardError::BadTreasury, "the fee must go to the treasury's account"));
    }
    if !grant.outputs.contains(mint_out.key) {
        return Err(fail(GuardError::MintNotAllowed, "the output mint is not allowed"));
    }

    // I2 and I6: the amounts.
    if amount == 0 {
        return Err(fail(GuardError::BadAmount, "nothing to swap"));
    }
    let fee = amount.checked_mul(FEE_BPS).ok_or(GuardError::Math)? / 10_000;
    let total = amount.checked_add(fee).ok_or(GuardError::Math)?;
    let day = now.div_euclid(SECONDS_PER_DAY);
    let limit = grant
        .limits
        .iter_mut()
        .find(|l| l.mint == *mint_in.key && l.mint != Pubkey::default())
        .ok_or_else(|| fail(GuardError::MintNotAllowed, "the input mint is not allowed"))?;
    if amount > limit.max_per_swap {
        return Err(fail(GuardError::OverSwapLimit, "above the owner's limit per swap"));
    }
    if limit.day != day {
        limit.day = day;
        limit.used_today = 0;
    }
    let used = limit.used_today.checked_add(total).ok_or(GuardError::Math)?;
    if used > limit.max_per_day {
        return Err(fail(GuardError::OverDailyLimit, "above the owner's daily limit"));
    }
    limit.used_today = used;

    // I10: the oracle check Settle will make, if the owner set one.
    let feed_of = |m: &Pubkey| grant.feeds.iter().find(|f| f.mint == *m && f.mint != Pubkey::default()).map(|f| f.feed);
    let (slippage_bps, feed_in, feed_out) = match (grant.max_slippage_bps, feed_of(mint_in.key), feed_of(mint_out.key)) {
        (0, _, _) => (0, Pubkey::default(), Pubkey::default()),
        (bps, Some(a), Some(b)) => (bps, a, b),
        _ if grant.allow_unpriced => (0, Pubkey::default(), Pubkey::default()),
        _ => return Err(fail(GuardError::Unpriced, "the owner requires a price for both mints, and one has no feed")),
    };

    // Record, then move: the hopper's balance before, the output's balance before.
    policy.pending = Pending {
        active: true,
        agent: *agent.key,
        owner_in: *owner_in.key,
        hopper: *hopper.key,
        hopper_before: hop.amount,
        owner_out: *owner_out.key,
        out_before: out.amount,
        min_out,
        mint_in: *mint_in.key,
        token_program_in: *token_in.key,
        slippage_bps,
        amount,
        decimals_in,
        decimals_out,
        feed_in,
        feed_out,
    };
    policy.write(&mut policy_info.try_borrow_mut_data()?);
    grant.write(&mut grant_info.try_borrow_mut_data()?);

    // I7: the authority signs only these two transfers, of exact amounts, to fixed destinations.
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, policy.owner.as_ref(), &[policy.authority_bump]];
    let infos = [owner_in.clone(), mint_in.clone(), hopper.clone(), treasury_in.clone(), authority.clone(), token_in.clone()];
    invoke_signed(&transfer_checked(token_in.key, owner_in.key, mint_in.key, hopper.key, &authority_key, amount, decimals_in), &infos, &[seeds])?;
    if fee > 0 {
        invoke_signed(&transfer_checked(token_in.key, owner_in.key, mint_in.key, treasury_in.key, &authority_key, fee, decimals_in), &infos, &[seeds])?;
    }
    Ok(())
}

/// `Settle`:
/// 0 agent (signer), 1 policy (writable), 2 hopper (writable), 3 owner_in (writable), 4 mint_in,
/// 5 token program of the input, 6 owner_out, and when the grant sets a slippage:
/// 7 Pyth price update of the input mint, 8 Pyth price update of the output mint
fn settle(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if get_stack_height() != TRANSACTION_LEVEL_STACK_HEIGHT {
        return Err(fail(GuardError::MustBeTopLevel, "settle must be a top-level instruction"));
    }
    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let agent = account(accounts, 0)?;
    let policy_info = account(accounts, 1)?;
    let hopper = account(accounts, 2)?;
    let owner_in = account(accounts, 3)?;
    let mint_in = account(accounts, 4)?;
    let token_in = account(accounts, 5)?;
    let owner_out = account(accounts, 6)?;

    let mut policy = load_policy(program_id, policy_info)?;
    let p = policy.pending;
    if !p.active {
        return Err(fail(GuardError::NoSwapInProgress, "settle without pull"));
    }
    if p.agent != *agent.key || p.hopper != *hopper.key || p.owner_in != *owner_in.key || p.owner_out != *owner_out.key
        || p.mint_in != *mint_in.key || p.token_program_in != *token_in.key
    {
        return Err(fail(GuardError::MismatchedSettle, "settle names other accounts than pull"));
    }
    require_signer(agent)?;

    // I4: what arrived in the owner's output account during this transaction.
    let out_now = amount_of(owner_out)?;
    let arrived = out_now.checked_sub(p.out_before).ok_or_else(|| fail(GuardError::BelowMinimum, "the output account shrank"))?;
    if arrived < p.min_out {
        msg!("guard: {} arrived, minimum {}", arrived, p.min_out);
        return Err(GuardError::BelowMinimum.into());
    }

    // I10: by Pyth's prices, the output is worth at least the input less the owner's slippage.
    if p.slippage_bps > 0 {
        let now = Clock::get()?.unix_timestamp;
        let price_in = read_price(account(accounts, 7)?, &p.feed_in, now)?;
        let price_out = read_price(account(accounts, 8)?, &p.feed_out, now)?;
        let floor = oracle_floor(p.amount, p.decimals_in, p.decimals_out, &price_in, &price_out, p.slippage_bps)?;
        if (arrived as u128) < floor {
            msg!("guard: {} arrived, the oracle's floor is {}", arrived, floor);
            return Err(GuardError::BelowOracle.into());
        }
    }

    // I5: the hopper ends where it started; what the route left goes back to the owner.
    let hop_now = amount_of(hopper)?;
    if hop_now < p.hopper_before {
        return Err(fail(GuardError::HopperShort, "the hopper lost more than the swap amount"));
    }
    let leftover = hop_now - p.hopper_before;
    if leftover > 0 {
        let decimals = checked_mint(mint_in, token_in.key)?;
        let ix = transfer_checked(token_in.key, hopper.key, mint_in.key, owner_in.key, agent.key, leftover, decimals);
        invoke(&ix, &[hopper.clone(), mint_in.clone(), owner_in.clone(), agent.clone(), token_in.clone()])?;
    }

    policy.pending = Pending::default();
    policy.write(&mut policy_info.try_borrow_mut_data()?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_round_trips() {
        let mut p = Policy { bump: 254, authority_bump: 253, paused: true, threshold: 2, owner: Pubkey::new_unique(), ..Default::default() };
        p.verifiers[0] = Pubkey::new_unique();
        p.programs[3] = Pubkey::new_unique();
        p.pending = Pending { active: true, min_out: 7, out_before: 9, hopper_before: 11, hopper: Pubkey::new_unique(), ..Default::default() };
        let mut data = vec![0u8; POLICY_SIZE];
        p.write(&mut data);
        assert_eq!(Policy::read(&data).unwrap(), p);
    }

    #[test]
    fn grant_round_trips() {
        let mut g = Grant { bump: 250, status: STATUS_PAUSED, expires_at: -5, owner: Pubkey::new_unique(), agent: Pubkey::new_unique(), ..Default::default() };
        g.limits[1] = Limit { mint: Pubkey::new_unique(), max_per_swap: 1, max_per_day: 2, used_today: 3, day: 4 };
        g.outputs[2] = Pubkey::new_unique();
        let mut data = vec![0u8; GRANT_SIZE];
        g.write(&mut data);
        assert_eq!(Grant::read(&data).unwrap(), g);
    }

    fn price_data(feed: &Pubkey, price: i64, conf: u64, expo: i32, publish_time: i64, level: u8) -> Vec<u8> {
        let mut d = PRICE_UPDATE_DISCRIMINATOR.to_vec();
        d.extend_from_slice(&[0u8; 32]);
        d.push(level);
        if level == 0 {
            d.push(5);
        }
        d.extend_from_slice(feed.as_ref());
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&conf.to_le_bytes());
        d.extend_from_slice(&expo.to_le_bytes());
        d.extend_from_slice(&publish_time.to_le_bytes());
        d.resize(134, 0);
        d
    }

    #[test]
    fn prices() {
        let feed = Pubkey::new_unique();
        let ok = price_data(&feed, 150_00000000, 5000000, -8, 1000, 1);
        assert_eq!(parse_price(&ok, &feed, 1030).unwrap().price, 150_00000000);
        assert!(parse_price(&ok, &Pubkey::new_unique(), 1030).is_err()); // another feed
        assert!(parse_price(&ok, &feed, 1061).is_err()); // stale
        assert!(parse_price(&price_data(&feed, 150_00000000, 5000000, -8, 1000, 0), &feed, 1030).is_err()); // partial
        assert!(parse_price(&price_data(&feed, 100, 3, -8, 1000, 1), &feed, 1030).is_err()); // conf 3% wide
        assert!(parse_price(&price_data(&feed, -1, 0, -8, 1000, 1), &feed, 1030).is_err());
    }

    #[test]
    fn floors() {
        let sol = Price { price: 150_00000000, conf: 0, expo: -8, publish_time: 0 };
        let usdc = Price { price: 1_00000000, conf: 0, expo: -8, publish_time: 0 };
        // 1 SOL (9 decimals) at $150 is 150 USDC (6 decimals); less 1%.
        assert_eq!(oracle_floor(1_000_000_000, 9, 6, &sol, &usdc, 0).unwrap(), 150_000_000);
        assert_eq!(oracle_floor(1_000_000_000, 9, 6, &sol, &usdc, 100).unwrap(), 148_500_000);
        // and back: 150 USDC is 1 SOL.
        assert_eq!(oracle_floor(150_000_000, 6, 9, &usdc, &sol, 0).unwrap(), 1_000_000_000);
        assert!(oracle_floor(u64::MAX, 0, 30, &sol, &usdc, 0).is_err());
    }

    #[test]
    fn thresholds() {
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        assert!(check_threshold(&[a, Pubkey::default()], 1).is_ok());
        assert!(check_threshold(&[a, b], 2).is_ok());
        assert!(check_threshold(&[a, Pubkey::default()], 2).is_err());
        assert!(check_threshold(&[a, a], 2).is_err());
        assert!(check_threshold(&[a, b], 0).is_err());
        assert!(check_threshold(&[a, b], 3).is_err());
    }

    #[test]
    fn extensions() {
        assert!(!extension_allowed(12, &[0; 32])); // PermanentDelegate
        assert!(!extension_allowed(9, &[])); // NonTransferable
        let mut hook = [0u8; 64];
        assert!(extension_allowed(14, &hook));
        hook[40] = 1;
        assert!(!extension_allowed(14, &hook));
    }
}
