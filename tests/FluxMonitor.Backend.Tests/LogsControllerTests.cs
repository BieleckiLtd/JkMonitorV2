using FluxMonitor.Backend.Controllers;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Status;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class LogsControllerTests
{
    [Fact]
    public async Task Delete_ClearsSelectedEntries()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var queryService = new FakeLogQueryService();
        var mutationService = new FakeLogMutationService
        {
            DeleteResult = 2
        };
        var controller = new LogsController(queryService, mutationService);

        var result = await controller.Delete(new LogsController.DeleteLogsRequest
        {
            EntryIds = [41, 42]
        }, cancellationToken);

        var ok = Assert.IsType<OkObjectResult>(result.Result);
        var payload = Assert.IsType<LogsController.DeleteLogsResponse>(ok.Value);

        Assert.Equal(2, payload.DeletedCount);
        Assert.Equal([41L, 42L], mutationService.DeletedEntryIds);
        Assert.False(mutationService.DeleteAllCalled);
    }

    [Fact]
    public async Task Delete_ClearsAllEntries()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var queryService = new FakeLogQueryService();
        var mutationService = new FakeLogMutationService
        {
            DeleteResult = 5
        };
        var controller = new LogsController(queryService, mutationService);

        var result = await controller.Delete(new LogsController.DeleteLogsRequest
        {
            DeleteAll = true
        }, cancellationToken);

        var ok = Assert.IsType<OkObjectResult>(result.Result);
        var payload = Assert.IsType<LogsController.DeleteLogsResponse>(ok.Value);

        Assert.Equal(5, payload.DeletedCount);
        Assert.True(mutationService.DeleteAllCalled);
        Assert.Null(mutationService.DeletedEntryIds);
    }

    [Fact]
    public async Task Delete_ReturnsBadRequest_WhenRequestIsAmbiguous()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var controller = new LogsController(new FakeLogQueryService(), new FakeLogMutationService());

        var result = await controller.Delete(new LogsController.DeleteLogsRequest
        {
            DeleteAll = true,
            EntryIds = [41]
        }, cancellationToken);

        var badRequest = Assert.IsType<BadRequestObjectResult>(result.Result);
        Assert.Equal("Specify either deleteAll=true or one or more entryIds.", badRequest.Value);
    }

    private sealed class FakeLogQueryService : ILogQueryService
    {
        public Task<LogQueryResponse> QueryAsync(
            IReadOnlyList<string>? levels,
            DateTimeOffset? from,
            DateTimeOffset? to,
            string? search,
            int skip,
            int take,
            CancellationToken cancellationToken)
            => Task.FromResult(new LogQueryResponse
            {
                Entries = [],
                TotalCount = 0
            });
    }

    private sealed class FakeLogMutationService : ILogMutationService
    {
        public int DeleteResult { get; init; }

        public bool DeleteAllCalled { get; private set; }

        public IReadOnlyList<long>? DeletedEntryIds { get; private set; }

        public Task<int> DeleteAllAsync(CancellationToken cancellationToken)
        {
            DeleteAllCalled = true;
            return Task.FromResult(DeleteResult);
        }

        public Task<int> DeleteAsync(IReadOnlyList<long> entryIds, CancellationToken cancellationToken)
        {
            DeletedEntryIds = entryIds.ToArray();
            return Task.FromResult(DeleteResult);
        }
    }
}
