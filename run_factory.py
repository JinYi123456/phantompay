import asyncio
import os
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver
from band import Agent, configure_logging
from band.adapters import LangGraphAdapter
from band.config import load_agent_config

async def run_single_agent(config_key: str):
    # 从 agent_config.yaml 中加载对应角色的 agent_id 和 api_key
    agent_id, api_key = load_agent_config(config_key)
    
    # 接入你的 GonkaRouter 网关和大模型配置
    adapter = LangGraphAdapter(
        llm=ChatOpenAI(
            model="deepseek-ai/DeepSeek-V4-Flash-0731",  # 或者用你的 deepseek-ai/DeepSeek-V4-Flash-0731
            base_url="https://api.gonkarouter.io/v1",
            api_key=os.getenv("GONKAROUTER_API_KEY")
        ),
        checkpointer=InMemorySaver(),
    )
    
    agent = Agent.create(
        adapter=adapter,
        agent_id=agent_id,
        api_key=api_key,
        ws_url=os.getenv("BAND_WS_URL", "wss://app.band.ai/api/v1/socket/websocket"),
        rest_url=os.getenv("BAND_REST_URL", "https://app.band.ai"),
    )
    print(f"[{config_key}] Agent successfully connected to Band via GonkaRouter!")
    await agent.run()

async def main():
    load_dotenv()
    configure_logging(root_level="INFO")
    
    # 同时并发启动这四个工厂角色（会自动去读 agent_config.yaml 里的配置）
    await asyncio.gather(
        run_single_agent("architect"),
        run_single_agent("implementer"),
        run_single_agent("reviewer"),
        run_single_agent("verifier"),
    )

if __name__ == "__main__":
    asyncio.run(main())