import type { ConfigMapping } from '@l2beat/backend-shared'
import { assert, type PremintedEntry, ProjectId } from '@l2beat/shared-pure'
import type { TvlConfig } from '../../../config/Config'
import { MulticallClient } from '../../../peripherals/multicall/MulticallClient'
import type { BlockTimestampIndexer } from '../indexers/BlockTimestampIndexer'
import type { DescendantIndexer } from '../indexers/DescendantIndexer'
import { PremintedIndexer } from '../indexers/PremintedIndexer'
import { ValueIndexer } from '../indexers/ValueIndexer'
import { AmountService } from '../services/AmountService'
import type { TvlDependencies } from './TvlDependencies'

interface PremintedModule {
  start: () => Promise<void> | void
}

export function initPremintedModule(
  config: TvlConfig,
  dependencies: TvlDependencies,
  configMapping: ConfigMapping,
  descendantPriceIndexer: DescendantIndexer,
  blockTimestampIndexers?: Map<string, BlockTimestampIndexer>,
): PremintedModule | undefined {
  const { dataIndexers, valueIndexers } = createIndexers(
    config,
    dependencies,
    configMapping,
    descendantPriceIndexer,
    blockTimestampIndexers,
  )

  if (dataIndexers.length === 0) return undefined

  return {
    start: async () => {
      for (const dataIndexer of dataIndexers) {
        await dataIndexer.start()
      }

      for (const valueIndexer of valueIndexers) {
        await valueIndexer.start()
      }
    },
  }
}

function createIndexers(
  config: TvlConfig,
  dependencies: TvlDependencies,
  configMapping: ConfigMapping,
  descendantPriceIndexer: DescendantIndexer,
  blockTimestampIndexers?: Map<string, BlockTimestampIndexer>,
) {
  const logger = dependencies.logger.tag({ module: 'preminted' })
  const indexerService = dependencies.indexerService
  const syncOptimizer = dependencies.syncOptimizer
  const circulatingSupplyService = dependencies.circulatingSupplyService
  const valueService = dependencies.valueService

  const dataIndexers: PremintedIndexer[] = []
  const valueIndexers: ValueIndexer[] = []

  for (const chain of config.chains) {
    const premintedTokens = config.amounts
      .filter((a) => a.chain === chain.name)
      .filter((a): a is PremintedEntry => a.type === 'preminted')

    if (premintedTokens.length === 0) {
      continue
    }

    const rpcClient = dependencies.clients.getRpcClient(chain.name)

    const amountService = new AmountService({
      rpcClient: rpcClient,
      multicallClient: new MulticallClient(rpcClient, chain.multicallConfig),
      logger: logger.tag({ tag: chain.name, chain: chain.name }),
    })

    const blockTimestampIndexer =
      blockTimestampIndexers && blockTimestampIndexers.get(chain.name)
    assert(
      blockTimestampIndexer,
      'blockTimestampIndexer should be defined for enabled chain',
    )

    for (const preminted of premintedTokens) {
      const indexer = new PremintedIndexer({
        logger,
        parents: [blockTimestampIndexer],
        indexerService,
        configuration: preminted,
        minHeight: preminted.sinceTimestamp,
        amountService,
        circulatingSupplyService,
        syncOptimizer,
        db: dependencies.database,
      })

      dataIndexers.push(indexer)

      const valueIndexer = new ValueIndexer({
        valueService,
        db: dependencies.database,
        priceConfigs: [configMapping.getPriceConfigFromAmountConfig(preminted)],
        amountConfigs: [preminted],
        project: ProjectId(preminted.project),
        dataSource: `${chain.name}_preminted_${preminted.address}`,
        syncOptimizer,
        parents: [descendantPriceIndexer, indexer],
        indexerService,
        logger,
        minHeight: preminted.sinceTimestamp,
        maxHeight: preminted.untilTimestamp,
        maxTimestampsToProcessAtOnce: config.maxTimestampsToAggregateAtOnce,
      })

      valueIndexers.push(valueIndexer)
    }
  }
  return { dataIndexers, valueIndexers }
}
