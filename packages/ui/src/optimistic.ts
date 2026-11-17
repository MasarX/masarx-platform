import {
  useMutation,
  useQueryClient,
  type MutationFunction,
  type QueryKey,
} from "@tanstack/react-query";

type OptimisticMutationOptions<TData, TVariables, TQueryData> = {
  mutationFn: MutationFunction<TData, TVariables>;
  queryKey: QueryKey;
  optimisticUpdate: (
    current: TQueryData | undefined,
    variables: TVariables
  ) => TQueryData;
  onError?: (error: unknown, variables: TVariables) => void;
};

export function useOptimisticMutation<TData, TVariables, TQueryData>({
  mutationFn,
  queryKey,
  optimisticUpdate,
  onError,
}: OptimisticMutationOptions<TData, TVariables, TQueryData>) {
  const queryClient = useQueryClient();

  return useMutation<TData, unknown, TVariables, { previous: TQueryData }>(
    {
      mutationFn,
      onMutate: async (variables) => {
        await queryClient.cancelQueries({ queryKey });
        const previous = queryClient.getQueryData<TQueryData>(queryKey);
        queryClient.setQueryData<TQueryData>(
          queryKey,
          (current) => optimisticUpdate(current, variables)
        );
        return { previous: previous as TQueryData };
      },
      onError: (error, variables, context) => {
        if (context?.previous) {
          queryClient.setQueryData(queryKey, context.previous);
        }
        onError?.(error, variables);
      },
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey });
      },
    }
  );
}
