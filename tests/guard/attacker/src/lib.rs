//! A deliberately malicious "swap program" for Orientim's CPI test (T6).
//!
//! Orientim hands the external swap program a temporary account (E_in), the one-time key E and, for
//! token outputs, the wallet's output account W_out. Everything else of the wallet's is withheld.
//! This program executes whatever inner instructions the test asks for, with whatever account
//! metas the test asks for, so that the Solana runtime — not Orientim's own checks — decides what an
//! external program can reach through a cross-program invocation.
//!
//! Instruction data (little endian):
//!
//! ```text
//! u8                  number of inner instructions
//! per instruction:
//!   key               the program to invoke
//!   u8                0 = invoke, 1 = invoke_signed with this program's own PDA seeds
//!   u8                number of account metas
//!   per meta:
//!     key
//!     u8              flags: bit 0 writable, bit 1 signer
//!   u16               length of the inner instruction data, then the data
//! ```
//!
//! A `key` is either an index into this instruction's own accounts (a byte below 0xFF) or 0xFF
//! followed by 32 raw bytes. The raw form lets the test demand an account the runtime never gave
//! this program — the wallet itself, for instance — which is exactly the attack Orientim's isolation
//! has to survive.

#![deny(unsafe_code)]

use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
};

/// Seed of the vault authority: a DEX-like pool account this program can sign for.
pub const VAULT_SEED: &[u8] = b"attacker";

entrypoint!(process_instruction);

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], ProgramError> {
        let end = self
            .at
            .checked_add(n)
            .ok_or(ProgramError::InvalidInstructionData)?;
        let out = self
            .data
            .get(self.at..end)
            .ok_or(ProgramError::InvalidInstructionData)?;
        self.at = end;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, ProgramError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, ProgramError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn key(&mut self, accounts: &[AccountInfo]) -> Result<Pubkey, ProgramError> {
        let index = self.u8()?;
        if index == 0xFF {
            let raw: [u8; 32] = self
                .take(32)?
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?;
            return Ok(Pubkey::new_from_array(raw));
        }
        accounts
            .get(index as usize)
            .map(|a| *a.key)
            .ok_or(ProgramError::NotEnoughAccountKeys)
    }
}

fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let mut r = Reader { data, at: 0 };
    let count = r.u8()?;
    for n in 0..count {
        let program = r.key(accounts)?;
        let signed = r.u8()? == 1;
        let meta_count = r.u8()?;
        let mut metas = Vec::with_capacity(meta_count as usize);
        for _ in 0..meta_count {
            let pubkey = r.key(accounts)?;
            let flags = r.u8()?;
            metas.push(AccountMeta {
                pubkey,
                is_signer: flags & 2 != 0,
                is_writable: flags & 1 != 0,
            });
        }
        let len = r.u16()? as usize;
        let ix = Instruction {
            program_id: program,
            accounts: metas,
            data: r.take(len)?.to_vec(),
        };
        msg!("attacker: inner instruction {}", n);
        if signed {
            let (_, bump) = Pubkey::find_program_address(&[VAULT_SEED], program_id);
            invoke_signed(&ix, accounts, &[&[VAULT_SEED, &[bump]]])?;
        } else {
            invoke(&ix, accounts)?;
        }
    }
    Ok(())
}
