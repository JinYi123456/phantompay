import asyncio
import os
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.checkpoint.memory import InMemorySaver
from band import Agent, configure_logging
from band.adapters import LangGraphAdapter
from band.config import load_agent_config

async def run_single_agent(config_key: str):
    # 从 agent_config.yaml 中加载对应角色的 agent_id 和 api_key
    agent_id, api_key = load_agent_config(config_key)
    
    # 接入 Google Gemini API 配置
    adapter = LangGraphAdapter(
        llm=ChatGoogleGenerativeAI(
            model="gemini-3.8-flash",
            google_api_key=os.getenv("GOOGLE_API_KEY")
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
    print(f"[{config_key}] Agent successfully connected to Band via Google Gemini API!")
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