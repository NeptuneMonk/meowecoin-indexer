import { fileSizes } from './decodeRoot.ts';
import type { DecodedRoot, PublicMessage } from './types.ts';

/**
 * Public messages are roots with a Message list.
 * OBJ.cs GetPublicMessagesByAddress: FromAddress is SignedBy, ToAddress is
 * the second-to-last keyword (or the only keyword).
 *
 * Private messages are roots with a SEC file. OBJ.cs GetPrivateMessagesByAddress
 * decrypts with the profile private key. This indexer has no keys, so the
 * body is the same placeholder Sup shows when decryption fails.
 */

export function messageRecipient(root: DecodedRoot): string {
  if (root.keywords.length >= 2) return root.keywords[root.keywords.length - 2]?.address ?? '';
  return root.keywords[0]?.address ?? '';
}

export function messagesFromRoot(root: DecodedRoot): PublicMessage[] {
  if (!root.isP2fk) return [];
  const found: PublicMessage[] = [];
  if (root.message.length > 0) {
    found.push({
      txid: root.transactionId,
      fromAddress: root.signedBy,
      toAddress: messageRecipient(root),
      message: root.message.join(' '),
      blockTime: root.blockTime,
      height: root.blockHeight,
      private: false,
      files: fileSizes(root),
    });
  }
  if (root.fileOrder.includes('SEC')) {
    found.push({
      txid: root.transactionId,
      fromAddress: root.keywords[root.keywords.length - 1]?.address ?? root.signedBy,
      toAddress: messageRecipient(root),
      message: '<UNABLE TO DECRYPT>',
      blockTime: root.blockTime,
      height: root.blockHeight,
      private: true,
      files: fileSizes(root),
    });
  }
  return found;
}
