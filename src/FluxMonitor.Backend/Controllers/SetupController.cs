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
}