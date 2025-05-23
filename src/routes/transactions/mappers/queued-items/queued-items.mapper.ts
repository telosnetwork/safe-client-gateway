import { Inject, Injectable } from '@nestjs/common';
import groupBy from 'lodash/groupBy';
import { MultisigTransaction } from '@/domain/safe/entities/multisig-transaction.entity';
import { Safe } from '@/domain/safe/entities/safe.entity';
import { MultisigTransactionMapper } from '@/routes/transactions/mappers/multisig-transactions/multisig-transaction.mapper';
import { Page } from '@/domain/entities/page.entity';
import { ConflictType } from '@/routes/transactions/entities/conflict-type.entity';
import { QueuedItem } from '@/routes/transactions/entities/queued-item.entity';
import { ConflictHeaderQueuedItem } from '@/routes/transactions/entities/queued-items/conflict-header-queued-item.entity';
import {
  LabelItem,
  LabelQueuedItem,
} from '@/routes/transactions/entities/queued-items/label-queued-item.entity';
import { TransactionQueuedItem } from '@/routes/transactions/entities/queued-items/transaction-queued-item.entity';
import { AddressInfoHelper } from '@/routes/common/address-info/address-info.helper';
import { IDataDecoderRepository } from '@/domain/data-decoder/v2/data-decoder.repository.interface';

class TransactionGroup {
  nonce!: number;
  transactions!: Array<MultisigTransaction>;
}

@Injectable()
export class QueuedItemsMapper {
  constructor(
    @Inject(IDataDecoderRepository)
    private readonly dataDecoderRepository: IDataDecoderRepository,
    private readonly mapper: MultisigTransactionMapper,
    private readonly addressInfoHelper: AddressInfoHelper,
  ) {}

  async getQueuedItems(
    transactions: Page<MultisigTransaction>,
    safe: Safe,
    chainId: string,
    previousPageLastNonce: number | null,
    nextPageFirstNonce: number | null,
  ): Promise<Array<QueuedItem>> {
    const transactionGroups = this.groupByNonce(transactions.results);
    let lastProcessedNonce = previousPageLastNonce ?? -1;

    return await Promise.all(
      transactionGroups.map(async (transactionGroup) => {
        const transactionGroupItems: Array<QueuedItem> = [];
        const { nonce } = transactionGroup;
        if (lastProcessedNonce < safe.nonce && nonce === safe.nonce) {
          transactionGroupItems.push(new LabelQueuedItem(LabelItem.Next));
        } else if (lastProcessedNonce <= safe.nonce && nonce > safe.nonce) {
          transactionGroupItems.push(new LabelQueuedItem(LabelItem.Queued));
        }
        lastProcessedNonce = nonce;

        const isEdgeGroup = nonce === nextPageFirstNonce;
        const isSingleItemGroup = transactionGroup.transactions.length === 1;
        const conflictFromPreviousPage = nonce === previousPageLastNonce;
        const hasConflicts = !isSingleItemGroup || isEdgeGroup;
        if (hasConflicts && !conflictFromPreviousPage) {
          transactionGroupItems.push(new ConflictHeaderQueuedItem(nonce));
        }

        const mappedTransactionItems = await this.getMappedTransactionGroup(
          chainId,
          safe,
          hasConflicts,
          conflictFromPreviousPage,
          isEdgeGroup,
          transactionGroup,
        );

        transactionGroupItems.push(...mappedTransactionItems);
        return transactionGroupItems;
      }),
    ).then((items) => items.flat());
  }

  private async getMappedTransactionGroup(
    chainId: string,
    safe: Safe,
    hasConflicts: boolean,
    conflictFromPreviousPage: boolean,
    isEdgeGroup: boolean,
    transactionGroup: TransactionGroup,
  ): Promise<Array<TransactionQueuedItem>> {
    // Prefetch tokens and contracts to avoid multiple parallel requests for the same address
    await this.mapper.prefetchAddressInfos({
      chainId: chainId,
      transactions: transactionGroup.transactions,
    });

    return Promise.all(
      transactionGroup.transactions.map(async (transaction, idx) => {
        const isFirstInGroup = idx === 0;
        const isLastInGroup = idx === transactionGroup.transactions.length - 1;
        const dataDecoded =
          await this.dataDecoderRepository.getTransactionDataDecoded({
            chainId,
            transaction,
          });
        return new TransactionQueuedItem(
          await this.mapper.mapTransaction(
            chainId,
            transaction,
            safe,
            dataDecoded,
          ),
          this.getConflictType(
            isFirstInGroup,
            isLastInGroup,
            hasConflicts,
            conflictFromPreviousPage,
            isEdgeGroup,
          ),
        );
      }),
    );
  }

  private getConflictType(
    isFirstInGroup: boolean,
    isLastInGroup: boolean,
    hasConflicts: boolean,
    conflictFromPreviousPage: boolean,
    isEdgeGroup: boolean,
  ): ConflictType {
    if (isFirstInGroup) {
      if (hasConflicts) {
        return ConflictType.HasNext;
      } else if (conflictFromPreviousPage) {
        return ConflictType.End;
      } else {
        return ConflictType.None;
      }
    }
    return !isLastInGroup || isEdgeGroup
      ? ConflictType.HasNext
      : ConflictType.End;
  }

  /**
   * Divides an array of transactions in groups with the same nonce.
   * Each TransactionGroup will contain at least one transaction.
   * @param transactions transactions with potentially different nonces.
   * @returns Array<TransactionGroup> in which each group of transactions has a different nonce.
   */
  private groupByNonce(
    transactions: Array<MultisigTransaction>,
  ): Array<TransactionGroup> {
    return Object.entries(groupBy(transactions, 'nonce')).map(
      ([nonce, transactions]): TransactionGroup => ({
        nonce: Number(nonce),
        transactions: transactions,
      }),
    );
  }
}
