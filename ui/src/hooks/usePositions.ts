import { useQuery } from '@apollo/client';
import { BytesLike } from 'ethers';
import { POSITIONS_QUERY_MARKET } from '../queries/positions';
import Wei from '@synthetixio/wei';
import { FuturesPosition_OrderBy, OrderDirection } from '../__generated__/graphql';
import { wei } from '@synthetixio/wei';
import { ContractData, SubgraphPositionData } from '../types';
import { POSITIONS_CONTRACT_QUERY } from '../queries/resolved';
import { useSearchParams } from 'react-router-dom';
import { useMarketSummaries } from './useMarketSummaries';
import { generateMarketIds } from './useActions';
import { InfuraProvider, JsonRpcProvider } from '@ethersproject/providers';
import { useEthersProvider } from '../utils/ProviderContext';
import { initMulticall, initPerpsMarketData } from '../utils';

export interface PositionType {
  accountType: string;
  address: string;
  asset: string;
  avgEntryPrice: Wei;
  fees: Wei;
  funding: Wei;
  indexPrice: Wei;
  leverage: Wei;
  liquidationPrice: Wei;
  long: boolean;
  marketPrice: Wei;
  notionalValue: Wei;
  realizedPnl: Wei;
  remainingMargin: Wei;
  size: Wei;
  unrealizedPnl: Wei;
  unrealizedPnlPercentage: Wei;
}

type OrderByKeys = 'realizedPnl' | 'unrealizedPnl' | 'margin';
type OrderByDirection = 'asc' | 'desc';

export const usePositions = (accountAddress?: string, accountType?: string) => {
  const [searchParams] = useSearchParams();
  const marketAddress = searchParams.get('markets') || null;
  const accountAddressLowerCase = accountAddress?.toLowerCase();
  const { provider } = useEthersProvider();

  const direction = searchParams.get('direction') || 'desc';
  const orderBy =
    searchParams.get('orderby') === 'size' ? 'margin' : searchParams.get('orderby') || 'margin';
  const page = Number(searchParams.get('page')) || 1;

  // get market ids from asset name
  const { data: marketConfigs } = useMarketSummaries();
  const marketsFilter = generateMarketIds(marketConfigs, marketAddress);

  // Initial query to give a list of markets
  const {
    data: marketData,
    loading: marketLoading,
    error: marketError,
  } = useQuery(POSITIONS_QUERY_MARKET, {
    variables: {
      where: {
        isOpen: true,
        trader: accountAddressLowerCase,
        market_in: marketsFilter,
      },
      orderBy: orderBy as FuturesPosition_OrderBy,
      orderDirection: direction as OrderDirection,
      first: 50,
      skip: (page - 1) * 50,
    },
    pollInterval: 10000,
  });

  const openPositions = marketData?.futuresPositions.map((item) => ({
    ...item,
    accountType,
    market: item.market.marketKey,
    asset: item.market.asset,
    walletAddress: item.trader.id,
    avgEntryPrice: wei(item.avgEntryPrice, 18, true),
    leverage: wei(item.leverage, 18, true),
    fees: wei(item.feesPaidToSynthetix, 18, true),
    unrealizedPnlAtLastModification: wei(item.unrealizedPnl, 18, true),
    realizedPnlAtLastModification: wei(item.realizedPnl, 18, true),
    netFundingAtLastModification: wei(item.netFunding, 18, true),
    fillPriceAtLastInteraction: wei(item.lastPrice, 18, true),
  }));

  const { data, loading, error } = useQuery(POSITIONS_CONTRACT_QUERY, {
    variables: {
      openPositions,
    },
    context: {
      provider,
    },
    skip: marketData?.futuresPositions ? false : true,
    pollInterval: 1000,
  });

  const positionsData = data?.positionsFromContract
    ? data.positionsFromContract.map((position: PositionType) => ({
        ...position,
        accountType,
      }))
    : undefined;

  const sortedData =
    positionsData && sortData(positionsData, orderBy as OrderByKeys, direction as OrderByDirection);

  return {
    data: sortedData,
    loading: loading || marketLoading,
    error: error || marketError,
  };
};

function sortData(data: PositionType[], orderBy: OrderByKeys, direction: OrderByDirection) {
  return data.slice().sort((a, b) => {
    let aValue: number, bValue: number;

    if (orderBy === 'margin') {
      aValue = Math.abs(a.size.toNumber()) * a.marketPrice.toNumber();
      bValue = Math.abs(b.size.toNumber()) * b.marketPrice.toNumber();
    } else {
      aValue = a[orderBy].toNumber();
      bValue = b[orderBy].toNumber();
    }

    return direction === 'asc' ? aValue - bValue : bValue - aValue;
  });
}

export async function fetchPositions(
  positionData: SubgraphPositionData[],
  provider: InfuraProvider | JsonRpcProvider
): Promise<ContractData[]> {
  const perpsMarketDataContract = initPerpsMarketData(provider);
  const Multicall3Contract = initMulticall(provider);

  const positionDetailCalls = positionData.map(({ market }, i) => ({
    target: perpsMarketDataContract.address,
    callData: perpsMarketDataContract.interface.encodeFunctionData('positionDetailsForMarketKey', [
      market,
      positionData[i].walletAddress,
    ]),
  }));

  const marketDetailCalls = positionData.map(({ market }) => ({
    target: perpsMarketDataContract.address,
    callData: perpsMarketDataContract.interface.encodeFunctionData('marketDetailsForKey', [market]),
  }));

  const multiCallResponse = await Multicall3Contract.callStatic.aggregate(
    positionDetailCalls.concat(marketDetailCalls)
  );

  const positionsDetailsMulticallResult = multiCallResponse.returnData.slice(
    0,
    positionDetailCalls.length
  );

  const marketDetailMulticallResult = multiCallResponse.returnData.slice(
    positionDetailCalls.length
  );

  // The result from decodeFunctionResult isn't typed, we could use zod to validate but doing a type assertion for now..
  const dataToReturn: ContractData[] = positionsDetailsMulticallResult.map(
    (positionDetailsBytes: BytesLike, index: number) => {
      const positionDetails = perpsMarketDataContract.interface.decodeFunctionResult(
        'positionDetailsForMarketKey',
        positionDetailsBytes
      )[0];

      const marketDetailsBytes = marketDetailMulticallResult[index];
      const { fundingParameters, marketSizeDetails, priceDetails } =
        perpsMarketDataContract.interface.decodeFunctionResult(
          'marketDetailsForKey',
          marketDetailsBytes
        )[0];

      return {
        size: wei(positionDetails.position.size),
        liquidationPrice: wei(positionDetails.liquidationPrice),
        skew: wei(marketSizeDetails.marketSkew),
        skewScale: wei(fundingParameters.skewScale),
        indexPrice: wei(priceDetails.price),
        accessibleMargin: wei(positionDetails.accessibleMargin),
        remainingMargin: wei(positionDetails.remainingMargin),
        accruedFundingSinceLastModification: wei(positionDetails.accruedFunding),
      };
    }
  );

  return dataToReturn;
}
