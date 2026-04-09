using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/setup")]
public sealed class SetupController(SetupConfigurationService setupConfigurationService) : ControllerBase
{
    [HttpGet]
    public ActionResult<SetupStateResponse> Get()
    {
        return Ok(setupConfigurationService.GetState());
    }

    [HttpPost("apply")]
    public ActionResult<ApplySetupResponse> Apply([FromBody] ApplySetupRequest request)
    {
        try
        {
            return Ok(setupConfigurationService.Apply(request));
        }
        catch (InvalidOperationException exception)
        {
            return BadRequest(new { message = exception.Message });
        }
    }

    [HttpGet("local-dependencies")]
    public ActionResult<LocalDependenciesStateResponse> GetLocalDependencies()
    {
        return Ok(setupConfigurationService.GetLocalDependenciesState());
    }

    [HttpPost("local-dependencies/install")]
    public ActionResult<InstallLocalDependenciesResponse> InstallLocalDependencies()
    {
        try
        {
            return Ok(setupConfigurationService.InstallLocalDependencies());
        }
        catch (InvalidOperationException exception)
        {
            return BadRequest(new { message = exception.Message });
        }
    }

    [HttpPost("restart")]
    public ActionResult<RestartApplicationResponse> Restart()
    {
        return Ok(setupConfigurationService.Restart());
    }
}
