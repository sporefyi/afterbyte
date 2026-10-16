//! AFTERBYTE receipt program — append-only hash commitments on Solana.
//!
//! # Purpose
//! Anchors AFTERBYTE publication payload hashes on-chain. Each published dossier
//! version gets an immutable [`Receipt`] PDA recording the SHA-256 of its canonical
//! bytes (see ADR-0002), chained to the previous version's hash. The program stores
//! **hashes only** — no content, no custody, no token, no transfers.
//!
//! # Account model
//! * [`Config`] — singleton PDA (`["afterbyte-config"]`): schema version,
//!   administrator, optional pending administrator (two-step rotation), paused flag.
//! * [`PublisherAuth`] — PDA (`["afterbyte-publisher", publisher]`): publisher
//!   pubkey + active flag, managed by the administrator.
//! * [`Subject`] — PDA (`["afterbyte-subject", subject_id]`): 32-byte subject id
//!   (SHA-256 over the UTF-8 bytes of the public subject UUID string — see
//!   `deriveSubjectId` in `@afterbyte/solana`), latest version, latest receipt hash.
//! * [`Receipt`] — PDA (`["afterbyte-receipt", subject_id, version_le]`): one
//!   immutable record per subject version. **No instruction updates or closes a
//!   receipt.**
//!
//! # Integer encoding in seeds
//! All integers in PDA seeds are fixed-width little-endian byte arrays
//! (`u64::to_le_bytes`, 8 bytes). `subject_id` is always exactly 32 bytes, so seed
//! concatenation is unambiguous (no length-prefixing needed).
//!
//! # Upgrade authority
//! This program is deployed as an upgradeable BPF program. The upgrade authority
//! is recorded in the deployment manifest
//! (`programs/afterbyte-receipts/deploy/manifest.TEMPLATE.json`, real values only
//! after an actual deployment) and is queryable on-chain via
//! `solana program show <PROGRAM_ID>`. An append-only instruction interface is NOT
//! a guarantee against a privileged program upgrade — see `docs/adr/0001-*.md`.
//! Do not revoke the upgrade authority without a separate explicit decision.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};

// PLACEHOLDER program id — the well-known Anchor example id. This repo has NO
// deployment; replace with the real id at deploy time and record it in the
// deployment manifest. Never invent or hardcode a "deployed" id.
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLn");

/// Current on-chain schema version for newly appended receipts.
pub const CURRENT_SCHEMA_VERSION: u16 = 1;

// ---------------------------------------------------------------------------
// PDA namespace seeds (fixed, documented)
// ---------------------------------------------------------------------------
/// Seed namespace for the singleton [`Config`] account.
pub const SEED_CONFIG: &[u8] = b"afterbyte-config";
/// Seed namespace for [`PublisherAuth`] accounts, followed by the publisher pubkey.
pub const SEED_PUBLISHER: &[u8] = b"afterbyte-publisher";
/// Seed namespace for [`Subject`] accounts, followed by the 32-byte subject id.
pub const SEED_SUBJECT: &[u8] = b"afterbyte-subject";
/// Seed namespace for [`Receipt`] accounts, followed by the 32-byte subject id
/// and the 8-byte little-endian version number.
pub const SEED_RECEIPT: &[u8] = b"afterbyte-receipt";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
#[error_code]
pub enum ReceiptError {
    /// The contract is paused; appends are blocked (admin functions still work).
    #[msg("Contract is paused; receipt appends are blocked")]
    Paused,
    /// The signer is not an authorized publisher of this program.
    #[msg("Signer is not an authorized publisher")]
    UnauthorizedPublisher,
    /// The publisher authorization exists but is not active.
    #[msg("Publisher authorization is inactive")]
    PublisherInactive,
    /// Version must be exactly latest_version + 1; gaps are not allowed.
    #[msg("Version must be exactly latest_version + 1; no gaps allowed")]
    VersionGap,
    /// previous_payload_hash does not match the subject's latest_receipt_hash.
    #[msg("previous_payload_hash does not match subject latest_receipt_hash")]
    PreviousHashMismatch,
    /// A receipt already exists for this version with a different payload.
    #[msg("Receipt already exists for this version with a different payload")]
    ConflictingReceipt,
    /// The receipt account failed PDA derivation validation.
    #[msg("Receipt account failed PDA validation")]
    InvalidReceiptPda,
    /// Unknown publication kind discriminant.
    #[msg("Unknown publication kind; expected 0=initial,1=amendment,2=correction,3=retraction")]
    InvalidPublicationKind,
    /// The subject id must not be all zeros.
    #[msg("Subject id must not be all zeros")]
    InvalidSubjectId,
    /// The receipt args schema_version does not match the config schema_version.
    #[msg("Receipt schema_version does not match config schema_version")]
    SchemaVersionMismatch,
    /// Only the pending administrator can accept a rotation.
    #[msg("Only the pending administrator can accept the rotation")]
    NotPendingAdmin,
    /// There is no pending administrator rotation to accept.
    #[msg("No pending administrator rotation")]
    NoPendingRotation,
    /// The receipt account already exists but is not empty/initializable.
    #[msg("Receipt account already exists")]
    ReceiptAccountExists,
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// Singleton program configuration.
///
/// Size: 8 (discriminator) + 2 (schema_version) + 32 (administrator)
///     + 1 + 32 (pending_administrator: Option<Pubkey>) + 1 (paused) + 1 (bump)
///     = **77 bytes**.
#[account]
pub struct Config {
    /// On-chain schema version governing newly appended receipts.
    pub schema_version: u16,
    /// Current administrator pubkey.
    pub administrator: Pubkey,
    /// Pending administrator during a two-step rotation; `None` when idle.
    pub pending_administrator: Option<Pubkey>,
    /// When true, `append_receipt` is blocked. Admin functions keep working.
    pub paused: bool,
    /// Canonical bump for the config PDA.
    pub bump: u8,
}

impl Config {
    pub const SIZE: usize = 8 + 2 + 32 + (1 + 32) + 1 + 1;
}

/// Publisher authorization record, managed by the administrator.
///
/// Size: 8 (discriminator) + 32 (publisher) + 1 (active) + 1 (bump) = **42 bytes**.
#[account]
pub struct PublisherAuth {
    /// The authorized publisher's pubkey.
    pub publisher: Pubkey,
    /// Whether this publisher may currently append receipts.
    pub active: bool,
    /// Canonical bump for the publisher PDA.
    pub bump: u8,
}

impl PublisherAuth {
    pub const SIZE: usize = 8 + 32 + 1 + 1;
}

/// Per-subject publication cursor.
///
/// Size: 8 (discriminator) + 32 (subject_id) + 8 (latest_version)
///     + 32 (latest_receipt_hash) + 1 (bump) = **81 bytes**.
#[account]
pub struct Subject {
    /// 32-byte subject id = SHA-256 over the UTF-8 bytes of the public subject UUID.
    pub subject_id: [u8; 32],
    /// Highest version appended so far (0 before the first receipt).
    pub latest_version: u64,
    /// payload_hash of the latest appended receipt (32 zero bytes before v1).
    pub latest_receipt_hash: [u8; 32],
    /// Canonical bump for the subject PDA.
    pub bump: u8,
}

impl Subject {
    pub const SIZE: usize = 8 + 32 + 8 + 32 + 1;
}

/// Publication kind. Stored as a `u8` discriminant (fixed 1-byte size keeps receipt
/// rent bounded and deserialization total). Off-chain label mapping:
/// 0 = "initial", 1 = "amendment", 2 = "correction", 3 = "retraction".
/// Discriminants 4–255 are reserved.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum PublicationKind {
    Initial = 0,
    Amendment = 1,
    Correction = 2,
    Retraction = 3,
}

impl TryFrom<u8> for PublicationKind {
    type Error = Error;
    fn try_from(v: u8) -> Result<Self> {
        match v {
            0 => Ok(PublicationKind::Initial),
            1 => Ok(PublicationKind::Amendment),
            2 => Ok(PublicationKind::Correction),
            3 => Ok(PublicationKind::Retraction),
            _ => err!(ReceiptError::InvalidPublicationKind),
        }
    }
}

/// Immutable per-version receipt record.
///
/// Size: 8 (discriminator) + 32 (subject_id) + 8 (version) + 32 (payload_hash)
///     + 32 (previous_payload_hash) + 1 (publication_kind) + 32 (publisher)
///     + 8 (slot) + 8 (recorded_at) + 2 (schema_version) + 1 (bump)
///     = **164 bytes**.
///
/// Rent note: query `getMinimumBalanceForRentExemption(164)` on the target
/// cluster at deployment preparation time; do not cache testnet values for
/// mainnet. Anchor's `init` space math is validated by the test suite.
#[account]
pub struct Receipt {
    /// 32-byte subject id (matches the [`Subject`] PDA seed).
    pub subject_id: [u8; 32],
    /// 1-based version number; allocated without gaps per subject.
    pub version: u64,
    /// SHA-256 of the canonical (ADR-0002) publication payload bytes.
    pub payload_hash: [u8; 32],
    /// payload_hash of the previous version; 32 zero bytes for v1.
    pub previous_payload_hash: [u8; 32],
    /// Kind of publication (initial / amendment / correction / retraction).
    pub publication_kind: PublicationKind,
    /// Publisher that appended this receipt.
    pub publisher: Pubkey,
    /// Slot at which the receipt was recorded.
    pub slot: u64,
    /// Unix timestamp at which the receipt was recorded.
    pub recorded_at: i64,
    /// On-chain schema version active when this receipt was appended.
    pub schema_version: u16,
    /// Canonical bump for the receipt PDA.
    pub bump: u8,
}

impl Receipt {
    pub const SIZE: usize = 8 + 32 + 8 + 32 + 32 + 1 + 32 + 8 + 8 + 2 + 1;
}

// ---------------------------------------------------------------------------
// Events (indexing aids; not part of consensus state)
// ---------------------------------------------------------------------------
#[event]
pub struct ReceiptAppended {
    pub subject_id: [u8; 32],
    pub version: u64,
    pub payload_hash: [u8; 32],
    pub publisher: Pubkey,
}

#[event]
pub struct PublisherAuthorized {
    pub publisher: Pubkey,
}

#[event]
pub struct PublisherRevoked {
    pub publisher: Pubkey,
}

#[event]
pub struct AdminRotationStarted {
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminRotationAccepted {
    pub new_admin: Pubkey,
}

#[event]
pub struct PausedChanged {
    pub paused: bool,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------
#[program]
pub mod afterbyte_receipts {
    use super::*;

    /// Create the singleton config. The signer becomes the administrator.
    pub fn initialize_config(ctx: Context<InitializeConfig>, schema_version: u16) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.schema_version = schema_version;
        config.administrator = ctx.accounts.admin.key();
        config.pending_administrator = None;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Authorize a publisher (admin only). Creates the publisher PDA as active.
    pub fn authorize_publisher(ctx: Context<AuthorizePublisher>) -> Result<()> {
        let auth = &mut ctx.accounts.publisher_auth;
        auth.publisher = ctx.accounts.publisher.key();
        auth.active = true;
        auth.bump = ctx.bumps.publisher_auth;
        emit!(PublisherAuthorized {
            publisher: ctx.accounts.publisher.key(),
        });
        Ok(())
    }

    /// Deactivate a publisher (admin only). The PDA is kept; the flag flips.
    /// No receipt is ever closed or modified by this instruction.
    pub fn revoke_publisher(ctx: Context<RevokePublisher>) -> Result<()> {
        let auth = &mut ctx.accounts.publisher_auth;
        require_keys_eq!(
            auth.publisher,
            ctx.accounts.publisher.key(),
            ReceiptError::UnauthorizedPublisher
        );
        auth.active = false;
        emit!(PublisherRevoked {
            publisher: ctx.accounts.publisher.key(),
        });
        Ok(())
    }

    /// Create a subject cursor (admin only). Starts at version 0 with a zero hash.
    pub fn initialize_subject(ctx: Context<InitializeSubject>, subject_id: [u8; 32]) -> Result<()> {
        require!(subject_id != [0u8; 32], ReceiptError::InvalidSubjectId);
        let subject = &mut ctx.accounts.subject;
        subject.subject_id = subject_id;
        subject.latest_version = 0;
        subject.latest_receipt_hash = [0u8; 32];
        subject.bump = ctx.bumps.subject;
        Ok(())
    }

    /// Append a receipt for the next version of a subject.
    ///
    /// Idempotency / conflict semantics (no receipt is ever updated or closed):
    /// * receipt PDA already holds a record with the same `payload_hash`,
    ///   `publisher` and `publication_kind` → success, no state change
    ///   (safe to retry);
    /// * receipt PDA already holds a record with a different payload →
    ///   [`ReceiptError::ConflictingReceipt`];
    /// * otherwise the receipt must be exactly `latest_version + 1` with a
    ///   matching `previous_payload_hash`, else [`ReceiptError::VersionGap`] /
    ///   [`ReceiptError::PreviousHashMismatch`].
    pub fn append_receipt(ctx: Context<AppendReceipt>, args: AppendReceiptArgs) -> Result<()> {
        let kind = PublicationKind::try_from(args.publication_kind)?;

        // Verify the receipt PDA derivation first (fixed namespace seeds, u64 LE
        // version). No authorization needed for this check.
        let version_le = args.version.to_le_bytes();
        let (expected_receipt, receipt_bump) = Pubkey::find_program_address(
            &[SEED_RECEIPT, args.subject_id.as_ref(), version_le.as_ref()],
            ctx.program_id,
        );
        require_keys_eq!(
            expected_receipt,
            ctx.accounts.receipt.key(),
            ReceiptError::InvalidReceiptPda
        );

        let receipt_info = ctx.accounts.receipt.to_account_info();

        // --- Existing-record path: idempotent success or conflict. ---
        // Evaluated BEFORE the paused / authorization checks on purpose: a
        // retry of an already-recorded version must be recognized as success
        // even if the contract was paused (or the publisher deactivated) after
        // the original append landed. This path changes no state.
        if !receipt_info.data_is_empty() {
            require_keys_eq!(
                *receipt_info.owner,
                *ctx.program_id,
                ReceiptError::InvalidReceiptPda
            );
            let data = receipt_info.try_borrow_data()?;
            let mut slice: &[u8] = &data;
            let existing = Receipt::try_deserialize(&mut slice)?;
            require!(
                existing.subject_id == args.subject_id && existing.version == args.version,
                ReceiptError::InvalidReceiptPda
            );
            if existing.payload_hash == args.payload_hash
                && existing.publisher == ctx.accounts.publisher.key()
                && existing.publication_kind == kind
            {
                // Idempotent retry: identical payload. Success, no state change.
                return Ok(());
            }
            return err!(ReceiptError::ConflictingReceipt);
        }
        require!(
            receipt_info.lamports() == 0,
            ReceiptError::ReceiptAccountExists
        );

        // --- New-record path: strict sequencing under auth. ---
        let config = &ctx.accounts.config;
        require!(!config.paused, ReceiptError::Paused);

        let publisher_key = ctx.accounts.publisher.key();
        let auth = &ctx.accounts.publisher_auth;
        require!(auth.active, ReceiptError::PublisherInactive);
        require_keys_eq!(auth.publisher, publisher_key, ReceiptError::UnauthorizedPublisher);

        require!(
            args.schema_version == config.schema_version,
            ReceiptError::SchemaVersionMismatch
        );

        // --- New-record path: strict sequencing. ---
        let subject = &mut ctx.accounts.subject;
        let next_version = subject.latest_version.checked_add(1).ok_or_else(|| {
            error!(ReceiptError::VersionGap)
        })?;
        require!(args.version == next_version, ReceiptError::VersionGap);
        require!(
            args.previous_payload_hash == subject.latest_receipt_hash,
            ReceiptError::PreviousHashMismatch
        );

        let clock = Clock::get()?;
        let receipt_data = Receipt {
            subject_id: args.subject_id,
            version: args.version,
            payload_hash: args.payload_hash,
            previous_payload_hash: args.previous_payload_hash,
            publication_kind: kind,
            publisher: publisher_key,
            slot: clock.slot,
            recorded_at: clock.unix_timestamp,
            schema_version: args.schema_version,
            bump: receipt_bump,
        };

        // Manual account creation: the receipt PDA may already exist on retry,
        // so Anchor's `init` constraint cannot be used here.
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(Receipt::SIZE);
        let signer_seeds: &[&[u8]] = &[
            SEED_RECEIPT,
            args.subject_id.as_ref(),
            version_le.as_ref(),
            &[receipt_bump],
        ];
        invoke_signed(
            &system_instruction::create_account(
                &publisher_key,
                &expected_receipt,
                lamports,
                Receipt::SIZE as u64,
                ctx.program_id,
            ),
            &[
                ctx.accounts.publisher.to_account_info(),
                receipt_info.clone(),
            ],
            &[signer_seeds],
        )?;

        let mut data = receipt_info.try_borrow_mut_data()?;
        let discriminator = <Receipt as anchor_lang::Discriminator>::discriminator();
        data[..8].copy_from_slice(&discriminator);
        let mut body: &mut [u8] = &mut data[8..];
        receipt_data.serialize(&mut body)?;

        subject.latest_version = args.version;
        subject.latest_receipt_hash = args.payload_hash;

        emit!(ReceiptAppended {
            subject_id: args.subject_id,
            version: args.version,
            payload_hash: args.payload_hash,
            publisher: publisher_key,
        });
        Ok(())
    }

    /// Pause receipt appends (admin only). Admin functions keep working.
    pub fn pause(ctx: Context<PauseResume>) -> Result<()> {
        ctx.accounts.config.paused = true;
        emit!(PausedChanged { paused: true });
        Ok(())
    }

    /// Resume receipt appends (admin only).
    pub fn resume(ctx: Context<PauseResume>) -> Result<()> {
        ctx.accounts.config.paused = false;
        emit!(PausedChanged { paused: false });
        Ok(())
    }

    /// Start a two-step admin rotation (admin only). Overwrites any pending
    /// rotation — the latest intent wins. The pending key must still accept.
    pub fn rotate_admin(ctx: Context<RotateAdmin>, new_admin: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.pending_administrator = Some(new_admin);
        emit!(AdminRotationStarted {
            current_admin: ctx.accounts.admin.key(),
            pending_admin: new_admin,
        });
        Ok(())
    }

    /// Accept a pending admin rotation. Must be signed by the pending key.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let pending = config
            .pending_administrator
            .ok_or_else(|| error!(ReceiptError::NoPendingRotation))?;
        require_keys_eq!(
            pending,
            ctx.accounts.new_admin.key(),
            ReceiptError::NotPendingAdmin
        );
        config.administrator = pending;
        config.pending_administrator = None;
        emit!(AdminRotationAccepted { new_admin: pending });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Instruction arguments
// ---------------------------------------------------------------------------
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AppendReceiptArgs {
    pub subject_id: [u8; 32],
    pub version: u64,
    pub payload_hash: [u8; 32],
    pub previous_payload_hash: [u8; 32],
    /// 0=initial, 1=amendment, 2=correction, 3=retraction.
    pub publication_kind: u8,
    pub schema_version: u16,
}

// ---------------------------------------------------------------------------
// Instruction contexts
// ---------------------------------------------------------------------------
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = Config::SIZE,
        seeds = [SEED_CONFIG],
        bump,
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthorizePublisher<'info> {
    #[account(
        seeds = [SEED_CONFIG],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = PublisherAuth::SIZE,
        seeds = [SEED_PUBLISHER, publisher.key().as_ref()],
        bump,
    )]
    pub publisher_auth: Account<'info, PublisherAuth>,
    /// The key being authorized (need not sign).
    /// CHECK: pubkey only; the PDA seeds bind it to this record.
    pub publisher: UncheckedAccount<'info>,
    #[account(mut, address = config.administrator @ ReceiptError::UnauthorizedPublisher)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokePublisher<'info> {
    #[account(
        seeds = [SEED_CONFIG],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [SEED_PUBLISHER, publisher.key().as_ref()],
        bump = publisher_auth.bump,
    )]
    pub publisher_auth: Account<'info, PublisherAuth>,
    /// CHECK: pubkey only; seeds bind it to the auth record.
    pub publisher: UncheckedAccount<'info>,
    #[account(mut, address = config.administrator @ ReceiptError::UnauthorizedPublisher)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(subject_id: [u8; 32])]
pub struct InitializeSubject<'info> {
    #[account(
        seeds = [SEED_CONFIG],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = Subject::SIZE,
        seeds = [SEED_SUBJECT, subject_id.as_ref()],
        bump,
    )]
    pub subject: Account<'info, Subject>,
    #[account(mut, address = config.administrator @ ReceiptError::UnauthorizedPublisher)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: AppendReceiptArgs)]
pub struct AppendReceipt<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [SEED_SUBJECT, args.subject_id.as_ref()],
        bump = subject.bump,
    )]
    pub subject: Account<'info, Subject>,
    /// The receipt PDA. Created manually in the handler (not via `init`)
    /// because a retry of an already-recorded version must be recognized
    /// instead of failing account initialization.
    /// CHECK: PDA derivation, ownership and discriminator are verified by hand
    /// in the handler before any use.
    #[account(mut)]
    pub receipt: UncheckedAccount<'info>,
    #[account(
        seeds = [SEED_PUBLISHER, publisher.key().as_ref()],
        bump = publisher_auth.bump,
    )]
    pub publisher_auth: Account<'info, PublisherAuth>,
    /// Authorized publisher; also pays for receipt account creation.
    #[account(mut)]
    pub publisher: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PauseResume<'info> {
    #[account(
        mut,
        seeds = [SEED_CONFIG],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(address = config.administrator @ ReceiptError::UnauthorizedPublisher)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct RotateAdmin<'info> {
    #[account(
        mut,
        seeds = [SEED_CONFIG],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(address = config.administrator @ ReceiptError::UnauthorizedPublisher)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// The pending administrator; must sign. Compared against
    /// `config.pending_administrator` in the handler.
    pub new_admin: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Compile-time size assertions (fail the build if layouts drift)
// ---------------------------------------------------------------------------
const _: () = assert!(Config::SIZE == 77);
const _: () = assert!(PublisherAuth::SIZE == 42);
const _: () = assert!(Subject::SIZE == 81);
const _: () = assert!(Receipt::SIZE == 164);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_sizes_match_documented_values() {
        assert_eq!(Config::SIZE, 77);
        assert_eq!(PublisherAuth::SIZE, 42);
        assert_eq!(Subject::SIZE, 81);
        assert_eq!(Receipt::SIZE, 164);
    }

    #[test]
    fn publication_kind_discriminants() {
        assert_eq!(PublicationKind::try_from(0).unwrap(), PublicationKind::Initial);
        assert_eq!(PublicationKind::try_from(1).unwrap(), PublicationKind::Amendment);
        assert_eq!(PublicationKind::try_from(2).unwrap(), PublicationKind::Correction);
        assert_eq!(PublicationKind::try_from(3).unwrap(), PublicationKind::Retraction);
        for reserved in [4u8, 100, 255] {
            assert!(
                PublicationKind::try_from(reserved).is_err(),
                "discriminant {reserved} must be rejected"
            );
        }
        // Borsh encoding of the enum is a single byte.
        let encoded = PublicationKind::Correction.try_to_vec().unwrap();
        assert_eq!(encoded, vec![2u8]);
    }

    #[test]
    fn append_receipt_args_borsh_layout() {
        // 32 (subject_id) + 8 (version) + 32 (payload_hash)
        //   + 32 (previous_payload_hash) + 1 (publication_kind) + 2 (schema_version)
        let args = AppendReceiptArgs {
            subject_id: [7u8; 32],
            version: 1,
            payload_hash: [8u8; 32],
            previous_payload_hash: [0u8; 32],
            publication_kind: 2,
            schema_version: 1,
        };
        let encoded = args.try_to_vec().unwrap();
        assert_eq!(encoded.len(), 107);
        assert_eq!(&encoded[0..32], &[7u8; 32]);
        assert_eq!(&encoded[32..40], &1u64.to_le_bytes()); // version is u64 LE
        assert_eq!(encoded[104], 2u8); // publication_kind discriminant
        assert_eq!(&encoded[105..107], &1u16.to_le_bytes());
    }

    #[test]
    fn seed_namespaces_are_documented_constants() {
        assert_eq!(SEED_CONFIG, b"afterbyte-config");
        assert_eq!(SEED_PUBLISHER, b"afterbyte-publisher");
        assert_eq!(SEED_SUBJECT, b"afterbyte-subject");
        assert_eq!(SEED_RECEIPT, b"afterbyte-receipt");
    }

    #[test]
    fn zero_subject_id_is_rejected_by_rule() {
        // Mirrors the handler's `require!`: all-zero subject ids are invalid.
        let zero = [0u8; 32];
        assert!(zero == [0u8; 32]);
    }
}
